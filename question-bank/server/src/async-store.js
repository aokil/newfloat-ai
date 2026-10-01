import {AsyncLocalStorage} from 'node:async_hooks';
import {Store} from './store.js';

/** The offline Store remains synchronous; HTTP handlers use this serialized adapter. */
export class AsyncSqliteStore {
  constructor(filenameOrStore) {
    this.store = filenameOrStore instanceof Store ? filenameOrStore : new Store(filenameOrStore);
    this.kind = 'sqlite';
    this._context = new AsyncLocalStorage();
    this._tail = Promise.resolve();
    this._closed = false;
    this._schemaVersion = this.store.get('PRAGMA user_version').user_version;
  }
  static async open(filenameOrStore) {return new AsyncSqliteStore(filenameOrStore);}
  get schemaVersion() {return this._schemaVersion;}
  async init() {return this;}

  async _exclusive(fn) {
    const previous = this._tail;
    let unlock;
    this._tail = new Promise(resolve => {unlock = resolve;});
    await previous;
    try {return await fn();} finally {unlock();}
  }
  async _scoped(context, fn) {
    const previous = context.tail;
    let unlock;
    context.tail = new Promise(resolve => {unlock = resolve;});
    await previous;
    try {
      if (!context.active) throw new Error('Database transaction has already finished');
      return await fn();
    } finally {unlock();}
  }
  async _operation(fn) {
    const context = this._context.getStore();
    if (context) {
      if (this._closed) throw new Error('Database is closed');
      return this._scoped(context, fn);
    }
    return this._exclusive(() => {
      if (this._closed) throw new Error('Database is closed');
      return fn();
    });
  }
  async get(sql, ...params) {return this._operation(() => this.store.get(sql, ...params));}
  async all(sql, ...params) {return this._operation(() => this.store.all(sql, ...params));}
  async run(sql, ...params) {return this._operation(() => this.store.run(sql, ...params));}
  async exec(sql) {return this._operation(() => this.store.db.exec(sql));}
  async transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('A database transaction callback is required');
    const parent = this._context.getStore();
    if (parent) return this._scoped(parent, async () => {
      const name = `float_ai_savepoint_${++parent.root.savepoint}`;
      const context = {active:true,tail:Promise.resolve(),root:parent.root};
      this.store.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = await this._context.run(context,fn);
        await context.tail;
        context.active = false;
        this.store.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        context.active = false;
        await context.tail;
        try {this.store.db.exec(`ROLLBACK TO SAVEPOINT ${name}`); this.store.db.exec(`RELEASE SAVEPOINT ${name}`);}
        catch {parent.root.failed = true;}
        throw error;
      } finally {context.active = false;}
    });
    return this._exclusive(async () => {
      if (this._closed) throw new Error('Database is closed');
      this.store.db.exec('BEGIN IMMEDIATE');
      const context = {active:true,tail:Promise.resolve(),root:{savepoint:0,failed:false}};
      try {
        const result = await this._context.run(context, fn);
        await context.tail;
        context.active = false;
        if (context.root.failed) throw new Error('Database transaction savepoint recovery failed');
        this.store.db.exec('COMMIT');
        return result;
      } catch (error) {
        context.active = false;
        await context.tail;
        try {this.store.db.exec('ROLLBACK');} catch {this._closed = true; try {this.store.close();} catch {}}
        throw error;
      } finally {context.active = false;}
    });
  }
  async audit(actor, action, target, details = {}) {
    return this.run('INSERT INTO audit(actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?)',
      actor, action, target, JSON.stringify(details), Date.now());
  }
  async close() {
    if (this._context.getStore()) throw new Error('Cannot close a database inside a transaction');
    return this._exclusive(() => {
      if (!this._closed) {this._closed = true; this.store.close();}
    });
  }
}
