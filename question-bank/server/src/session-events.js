import {ApiError, authenticateSessionEvents} from './security.js';

/** One authenticated event stream per client; no account/points polling. */
export class SessionEvents {
  constructor(store) {
    this.store = store;
    this.listeners = new Map();
    this.streams = new Set();
    this.ready = store.kind !== 'postgres';
    this.closed = false;
    this.retry = null;
    this.connecting = null;
    this.disconnect = null;
    this.failures = 0;
  }
  start() {
    if (this.closed || this.ready || this.connecting || this.store.kind !== 'postgres') return;
    this.connecting = this.store.listenSessionChanges(userId => this.emit(userId), () => this.lost())
      .then(async disconnect => {
        if (this.closed) {await disconnect(); return;}
        this.disconnect = disconnect; this.ready = true; this.failures = 0;
      }).catch(() => this.lost()).finally(() => {this.connecting = null;});
  }
  lost() {
    this.ready = false;
    this.disconnect = null;
    // While cross-instance notifications are unavailable no stream claims to
    // be current. Clients reconnect and reauthenticate, without signing out.
    for (const close of [...this.streams]) close();
    if (!this.closed && !this.retry) {
      const delay = Math.min(60_000,1000 * 2 ** Math.min(this.failures++,6));
      this.retry = setTimeout(() => {this.retry = null; this.start();},delay);
      this.retry.unref();
    }
  }
  emit(userId) {for (const listener of this.listeners.get(userId) || []) listener();}
  async changed(userId) {
    if (this.store.kind === 'postgres') await this.store.notifySessionChange(userId);
    else this.store.afterCommit(() => this.emit(userId));
  }
  subscribe(userId,listener) {
    const group = this.listeners.get(userId) || new Set();
    if (group.size >= 4 || this.streams.size >= 4096) throw new ApiError(429,'RATE_LIMITED','会话通知连接过多');
    group.add(listener); this.listeners.set(userId,group);
    return () => {group.delete(listener); if (!group.size) this.listeners.delete(userId);};
  }
  async close() {
    this.closed = true; this.ready = false; clearTimeout(this.retry);
    for (const close of [...this.streams]) close();
    await this.connecting;
    await this.disconnect?.(); this.disconnect = null;
  }
}

export function registerSessionEvents(app, store, events) {
  app.get('/v1/auth/session-events', async (req,reply) => {
    const session = await authenticateSessionEvents(store,req);
    if (!events.ready) throw new ApiError(503,'SESSION_EVENTS_UNAVAILABLE','会话通知暂不可用');
    let opened = false, closed = false, dirty = false, checking = false;
    let heartbeat, expiry;
    const close = () => {
      if (closed) return;
      closed = true; unsubscribe(); events.streams.delete(close);
      clearInterval(heartbeat); clearTimeout(expiry);
      if (opened && !reply.raw.destroyed) reply.raw.end();
    };
    const write = (event,data) => {
      if (!closed && opened && !reply.raw.destroyed) {
        // Stop slow/broken readers instead of buffering unbounded keepalives.
        if (reply.raw.writableLength > 16 * 1024) {close(); return;}
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    };
    const check = async () => {
      dirty = true;
      if (!opened || closed || checking) return;
      checking = true;
      try {
        while (dirty && !closed) {
          dirty = false;
          const current = await store.get('SELECT s.revoked,u.disabled FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.user_id=?',session.id,session.user_id);
          if (!current || current.revoked || current.disabled) {
            write('revoked',{sessionId:session.id,code:current?.disabled ? 'ACCOUNT_DISABLED' : 'SESSION_REVOKED'});
            close();
          }
        }
      } catch {close();} finally {checking = false;}
    };
    const unsubscribe = events.subscribe(session.user_id,() => {void check();});
    try {
      // Subscribe first, then check again: a concurrent login cannot slip
      // between the initial authentication and event registration.
      await authenticateSessionEvents(store,req);
      if (!events.ready) throw new ApiError(503,'SESSION_EVENTS_UNAVAILABLE','会话通知暂不可用');
      reply.hijack(); opened = true; events.streams.add(close);
      reply.raw.on('close',close); reply.raw.on('error',close);
      reply.raw.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform',
        'X-Accel-Buffering':'no','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
      reply.raw.flushHeaders();
      write('ready',{sessionId:session.id});
      heartbeat = setInterval(() => {
        if (reply.raw.writableLength > 16 * 1024) close();
        else if (!closed && !reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
      },20_000); heartbeat.unref();
      // The stream grants only revocation events, never extends login/points
      // leases and never refreshes a token. Heartbeats do not query the DB.
      expiry = setTimeout(close,Math.max(1,Math.min(24 * 60 * 60 * 1000,session.refresh_expires-Date.now()))); expiry.unref();
      if (dirty) void check();
    } catch (error) {close(); throw error;}
    return reply;
  });
}
