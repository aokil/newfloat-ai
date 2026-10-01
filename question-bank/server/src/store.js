import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), {recursive: true, mode: 0o700});
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 8) {this.db.close();throw new Error('Database schema is newer than this server');}
    if (version === 0) this.transaction(() => this.db.exec(`
      CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user','admin')), disabled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), family_id TEXT NOT NULL, client_id TEXT NOT NULL,
        access_hash TEXT NOT NULL UNIQUE, refresh_hash TEXT NOT NULL UNIQUE, access_expires INTEGER NOT NULL,
        refresh_expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE INDEX sessions_family ON sessions(family_id);
      CREATE TABLE used_refresh(token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE imports(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), filename TEXT NOT NULL,
        format TEXT NOT NULL, file_sha TEXT NOT NULL, preview TEXT NOT NULL, created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, committed_bank_id TEXT, committed_version TEXT, title TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, source BLOB NOT NULL, warnings TEXT NOT NULL);
      CREATE INDEX imports_owner ON imports(owner_id,created_at);
      CREATE TABLE banks(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL,
        current_version TEXT NOT NULL, sequence INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX banks_owner ON banks(owner_id,updated_at);
      CREATE TABLE private_versions(bank_id TEXT NOT NULL REFERENCES banks(id), data_version TEXT NOT NULL,
        sequence INTEGER NOT NULL, payload TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL,
        question_count INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(bank_id,data_version));
      CREATE TABLE confirmations(owner_id TEXT NOT NULL REFERENCES users(id), idempotency_key TEXT NOT NULL,
        request_hash TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(owner_id,idempotency_key));
      CREATE TABLE reviews(id TEXT PRIMARY KEY, bank_id TEXT NOT NULL REFERENCES banks(id), data_version TEXT NOT NULL,
        reviewer_id TEXT NOT NULL REFERENCES users(id), decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
        note TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE releases(id TEXT PRIMARY KEY, public_bank_id TEXT NOT NULL, data_version TEXT NOT NULL UNIQUE,
        release_sequence INTEGER NOT NULL UNIQUE, source_bank_id TEXT NOT NULL REFERENCES banks(id), source_version TEXT NOT NULL,
        review_id TEXT NOT NULL REFERENCES reviews(id), publisher_id TEXT NOT NULL REFERENCES users(id),
        payload TEXT NOT NULL, sha256 TEXT NOT NULL, size_bytes INTEGER NOT NULL, question_count INTEGER NOT NULL,
        title TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('published','withdrawn')), created_at INTEGER NOT NULL,
        withdrawn_at INTEGER, UNIQUE(source_bank_id,source_version));
      CREATE INDEX releases_state ON releases(state,public_bank_id,release_sequence);
      CREATE TABLE audit(id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT, action TEXT NOT NULL,
        target_id TEXT NOT NULL, details TEXT NOT NULL, created_at INTEGER NOT NULL);
      PRAGMA user_version=1;
    `));
    if (version < 2) this.transaction(() => this.db.exec(`
      ALTER TABLE users ADD COLUMN phone_number TEXT;
      ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN last_login_at INTEGER;
      ALTER TABLE users ADD COLUMN membership TEXT NOT NULL DEFAULT 'free';
      ALTER TABLE users ADD COLUMN membership_expires INTEGER;
      ALTER TABLE users ADD COLUMN trial_started INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN trial_ends INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN points_balance INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN points_reserved INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE users ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
      UPDATE users SET trial_started=created_at,trial_ends=created_at+900000;
      CREATE UNIQUE INDEX users_phone ON users(phone_number) WHERE phone_number IS NOT NULL;
      CREATE TABLE points_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),delta INTEGER NOT NULL,
        balance_before INTEGER NOT NULL,balance_after INTEGER NOT NULL,reason TEXT NOT NULL,actor_id TEXT,idempotency_key TEXT NOT NULL,
        created_at INTEGER NOT NULL,UNIQUE(user_id,idempotency_key));
      CREATE TABLE sms_challenges(id TEXT PRIMARY KEY,phone TEXT NOT NULL,code_hmac TEXT NOT NULL,expires_at INTEGER NOT NULL,
        used_at INTEGER,attempts INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,ip_hash TEXT NOT NULL,state TEXT NOT NULL);
      CREATE INDEX sms_phone_time ON sms_challenges(phone,created_at);
      CREATE INDEX sms_ip_time ON sms_challenges(ip_hash,created_at);
      CREATE TABLE sms_failures(phone TEXT NOT NULL,created_at INTEGER NOT NULL);
      CREATE TABLE models(id TEXT PRIMARY KEY,config TEXT NOT NULL,encrypted_key TEXT,key_fingerprint TEXT,revision INTEGER NOT NULL,
        last_test_at INTEGER,last_test_status TEXT,last_test_error TEXT,last_test_result TEXT,created_at INTEGER NOT NULL);
      CREATE TABLE model_tests(id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES models(id),actor_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at INTEGER NOT NULL,
        UNIQUE(actor_id,idempotency_key));
      CREATE TABLE announcements(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,
        audience TEXT NOT NULL,published_at INTEGER,starts_at INTEGER,ends_at INTEGER,created_at INTEGER NOT NULL);
      CREATE TABLE announcement_dismissals(user_id TEXT NOT NULL REFERENCES users(id),announcement_id TEXT NOT NULL REFERENCES announcements(id),
        version INTEGER NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(user_id,announcement_id,version));
      PRAGMA user_version=2;
    `));
    if(version<3)this.transaction(()=>{
      this.db.exec("ALTER TABLE imports ADD COLUMN summary TEXT NOT NULL DEFAULT '{}'; PRAGMA user_version=3;");
      for(const row of this.all('SELECT id,preview FROM imports')){
        const items=JSON.parse(row.preview);this.run('UPDATE imports SET summary=? WHERE id=?',JSON.stringify({questionCount:items.length,errorCount:items.reduce((n,q)=>n+q.errors.length,0)}),row.id);
      }
    });
    if(version<4)this.transaction(()=>this.db.exec(`
      ALTER TABLE sms_challenges ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
      ALTER TABLE sms_challenges ADD COLUMN issuer TEXT;
      ALTER TABLE sms_challenges ADD COLUMN attempt_nonce TEXT;
      CREATE TABLE external_phone_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id),phone TEXT NOT NULL,verified_at INTEGER NOT NULL,
        PRIMARY KEY(issuer,subject));
      PRAGMA user_version=4;
    `));
    if(version<5)this.transaction(()=>this.db.exec(`
      ALTER TABLE sms_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'registration';
      ALTER TABLE sms_challenges ADD COLUMN target_user_id TEXT;
      CREATE INDEX sms_target_purpose ON sms_challenges(target_user_id,purpose,created_at);
      PRAGMA user_version=5;
    `));
    if(version<6)this.transaction(()=>this.db.exec(`
      ALTER TABLE banks ADD COLUMN deleted_at INTEGER;
      PRAGMA user_version=6;
    `));
    if(version<7)this.transaction(()=>this.db.exec(`
      ALTER TABLE banks ADD COLUMN description TEXT NOT NULL DEFAULT '';
      PRAGMA user_version=7;
    `));
    if(version<8)this.transaction(()=>this.db.exec(`
      ALTER TABLE users ADD COLUMN avatar_id TEXT;
      CREATE TABLE ai_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
        session_id TEXT NOT NULL REFERENCES sessions(id),idempotency_hash TEXT NOT NULL,request_hash TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('builtin','byok')),model_id TEXT REFERENCES models(id),model_revision INTEGER,
        catalog_key TEXT,points_cost INTEGER NOT NULL CHECK(points_cost>=0),
        status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),result TEXT,error_code TEXT,error_message TEXT,http_status INTEGER,
        created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,
        UNIQUE(user_id,idempotency_hash));
      CREATE INDEX ai_requests_pending ON ai_requests(status,expires_at);
      CREATE INDEX ai_requests_user_time ON ai_requests(user_id,created_at);
      CREATE INDEX ai_requests_model_time ON ai_requests(model_id,created_at);
      PRAGMA user_version=8;
    `));
  }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, target, details = {}) {
    this.run('INSERT INTO audit(actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?)', actor, action, target, JSON.stringify(details), Date.now());
  }
  close() { this.db.close(); }
}
