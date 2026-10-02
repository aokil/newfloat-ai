import {AsyncLocalStorage} from 'node:async_hooks';
import pg from 'pg';

const {Pool, types} = pg;
const SCHEMA_VERSION = 9;
// All instances share these transaction locks, including single-statement writes.
const LOCK_NAMESPACE = 1179406145;
const WRITE_LOCK = 1413564759;
const MIGRATION_LOCK = 1413564749;
const APPLICATION_TABLES = ['users','sessions','used_refresh','imports','banks','private_versions','confirmations',
  'reviews','releases','audit','points_ledger','sms_challenges','sms_failures','models','model_tests',
  'announcements','announcement_dismissals','external_phone_identities','ai_requests','payment_orders'];

// Coze can copy DDL without rows. An empty copied schema is accepted only when
// this complete version-8/9 structural contract matches; a partial/unknown schema
// must never be blessed with a version marker merely because it has no data.
const SCHEMA_8_COLUMNS = {
  users:'id:text username:text display_name:text password_hash:text role:text disabled:integer created_at:bigint phone_number:text? phone_verified:integer last_login_at:bigint? membership:text membership_expires:bigint? trial_started:bigint trial_ends:bigint points_balance:bigint points_reserved:bigint revision:integer avatar_id:text?',
  sessions:'id:text user_id:text family_id:text client_id:text access_hash:text refresh_hash:text access_expires:bigint refresh_expires:bigint revoked:integer created_at:bigint',
  used_refresh:'token_hash:text family_id:text expires_at:bigint',
  imports:'id:text owner_id:text filename:text format:text file_sha:text preview:text created_at:bigint expires_at:bigint committed_bank_id:text? committed_version:text? title:text revision:integer status:text source:bytea warnings:text summary:text',
  banks:'id:text owner_id:text title:text current_version:text sequence:integer created_at:bigint updated_at:bigint deleted_at:bigint? description:text',
  private_versions:'bank_id:text data_version:text sequence:integer payload:text sha256:text size_bytes:bigint question_count:integer created_at:bigint',
  confirmations:'owner_id:text idempotency_key:text request_hash:text result:text',
  reviews:'id:text bank_id:text data_version:text reviewer_id:text decision:text note:text created_at:bigint',
  releases:'id:text public_bank_id:text data_version:text release_sequence:integer source_bank_id:text source_version:text review_id:text publisher_id:text payload:text sha256:text size_bytes:bigint question_count:integer title:text state:text created_at:bigint withdrawn_at:bigint?',
  audit:'id:bigint actor_id:text? action:text target_id:text details:text created_at:bigint',
  points_ledger:'id:text user_id:text delta:bigint balance_before:bigint balance_after:bigint reason:text actor_id:text? idempotency_key:text created_at:bigint',
  sms_challenges:'id:text phone:text code_hmac:text expires_at:bigint used_at:bigint? attempts:integer created_at:bigint ip_hash:text state:text provider:text issuer:text? attempt_nonce:text? purpose:text target_user_id:text?',
  sms_failures:'phone:text created_at:bigint',
  models:'id:text config:text encrypted_key:text? key_fingerprint:text? revision:integer last_test_at:bigint? last_test_status:text? last_test_error:text? last_test_result:text? created_at:bigint',
  model_tests:'id:text model_id:text actor_id:text idempotency_key:text request_hash:text status:text result:text? created_at:bigint',
  announcements:'id:text title:text body:text version:integer status:text audience:text published_at:bigint? starts_at:bigint? ends_at:bigint? created_at:bigint',
  announcement_dismissals:'user_id:text announcement_id:text version:integer created_at:bigint',
  external_phone_identities:'issuer:text subject:text user_id:text phone:text verified_at:bigint',
  ai_requests:'id:text user_id:text session_id:text idempotency_hash:text request_hash:text mode:text model_id:text? model_revision:integer? catalog_key:text? points_cost:bigint status:text result:text? error_code:text? error_message:text? http_status:integer? created_at:bigint updated_at:bigint expires_at:bigint',
  schema_metadata:'singleton:integer version:integer updated_at:bigint'
};
const SCHEMA_8_DEFAULTS = {
  'users.disabled':'0','users.phone_verified':'0','users.membership':"'free'",'users.trial_started':'0','users.trial_ends':'0',
  'users.points_balance':'0','users.points_reserved':'0','users.revision':'1','sessions.revoked':'0',
  'imports.summary':"'{}'",'banks.description':"''",'sms_challenges.attempts':'0','sms_challenges.provider':"'local'",'sms_challenges.purpose':"'registration'"
};
const SCHEMA_8_PRIMARY = {
  users:'id',sessions:'id',used_refresh:'token_hash',imports:'id',banks:'id',private_versions:'bank_id,data_version',
  confirmations:'owner_id,idempotency_key',reviews:'id',releases:'id',audit:'id',points_ledger:'id',sms_challenges:'id',
  models:'id',model_tests:'id',announcements:'id',announcement_dismissals:'user_id,announcement_id,version',
  external_phone_identities:'issuer,subject',ai_requests:'id',schema_metadata:'singleton'
};
const SCHEMA_8_UNIQUE = {
  users:['username'],sessions:['access_hash','refresh_hash'],releases:['data_version','release_sequence','source_bank_id,source_version'],
  points_ledger:['user_id,idempotency_key'],model_tests:['actor_id,idempotency_key'],external_phone_identities:['user_id'],ai_requests:['user_id,idempotency_hash']
};
const SCHEMA_8_FOREIGN = {
  sessions:{user_id:'users.id'},imports:{owner_id:'users.id'},banks:{owner_id:'users.id'},private_versions:{bank_id:'banks.id'},
  confirmations:{owner_id:'users.id'},reviews:{bank_id:'banks.id',reviewer_id:'users.id'},
  releases:{source_bank_id:'banks.id',review_id:'reviews.id',publisher_id:'users.id'},points_ledger:{user_id:'users.id'},
  model_tests:{model_id:'models.id'},announcement_dismissals:{user_id:'users.id',announcement_id:'announcements.id'},
  external_phone_identities:{user_id:'users.id'},ai_requests:{user_id:'users.id',session_id:'sessions.id',model_id:'models.id'}
};
const SCHEMA_8_CHECKS = {
  users:["role IN ('user','admin')"],reviews:["decision IN ('approved','rejected')"],releases:["state IN ('published','withdrawn')"],
  ai_requests:["mode IN ('builtin','byok')","status IN ('pending','completed','failed')",'points_cost>=0'],schema_metadata:['singleton=1']
};
const SCHEMA_8_INDEXES = {
  sessions_family:['sessions','family_id'],imports_owner:['imports','owner_id,created_at'],banks_owner:['banks','owner_id,updated_at'],
  releases_state:['releases','state,public_bank_id,release_sequence'],users_phone:['users','phone_number',true,'phone_number IS NOT NULL'],
  sms_phone_time:['sms_challenges','phone,created_at'],sms_ip_time:['sms_challenges','ip_hash,created_at'],
  sms_target_purpose:['sms_challenges','target_user_id,purpose,created_at'],ai_requests_pending:['ai_requests','status,expires_at'],
  ai_requests_user_time:['ai_requests','user_id,created_at'],ai_requests_model_time:['ai_requests','model_id,created_at']
};
const PAYMENT_COLUMNS='id:text owner_id:text idempotency_hash:text request_hash:text environment:text app_id:text seller_id:text package_id:text package_title:text amount_minor:bigint points:bigint status:text qr_code:text? trade_no:text? receipt_hash:text? error_code:text? created_at:bigint updated_at:bigint expires_at:bigint precreate_at:bigint checked_at:bigint? paid_at:bigint?';
const PAYMENT_CHECKS=["environment IN ('sandbox','production')",'amount_minor>0','points>0',"status IN ('creating','pending','uncertain','failed','paid','closed')"];

function safeInteger(value) {
  if (!/^[+-]?\d+(?:\.0+)?$/u.test(String(value))) throw new RangeError('Database numeric value is not an integer');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw new RangeError('Database integer is outside the safe application range');
  return result;
}
const numericTypes = {getTypeParser(oid, format) {
  if ([20,1700].includes(oid) && format !== 'binary') return safeInteger;
  return types.getTypeParser(oid, format);
}};

function connectionOptions(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new TypeError('PostgreSQL configuration is required');
  const options = {max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000, types: numericTypes};
  for (const key of ['connectionString','host','port','database','user','password','max','idleTimeoutMillis',
    'connectionTimeoutMillis','statement_timeout','query_timeout','application_name']) {
    if (config[key] !== undefined) options[key] = config[key];
  }
  let ssl = config.ssl;
  if (options.connectionString) {
    let uri;
    try {uri = new URL(options.connectionString);} catch {throw new Error('PostgreSQL connection URL is invalid');}
    if (!['postgres:','postgresql:'].includes(uri.protocol)) throw new Error('PostgreSQL connection URL is invalid');
    const mode = uri.searchParams.get('sslmode');
    const sslFlag = uri.searchParams.get('ssl');
    if (sslFlag && !['true','false','1','0'].includes(sslFlag)) throw new Error('Untrusted PostgreSQL TLS mode is not allowed');
    if (mode && !['disable','prefer','require','verify-ca','verify-full'].includes(mode)) throw new Error('Untrusted PostgreSQL TLS mode is not allowed');
    if (['sslcert','sslkey','sslrootcert'].some(key => uri.searchParams.has(key))) throw new Error('Provide PostgreSQL TLS certificates through trusted configuration');
    if (mode && mode !== 'disable') {
      if (ssl === false) throw new Error('PostgreSQL TLS configuration conflicts with the connection URL');
      ssl ??= true;
    }
    if (sslFlag === 'true' || sslFlag === '1') {
      if (ssl === false) throw new Error('PostgreSQL TLS configuration conflicts with the connection URL');
      ssl ??= true;
    }
    if (mode === 'disable' || sslFlag === 'false' || sslFlag === '0') {
      if (ssl !== undefined && ssl !== false) throw new Error('PostgreSQL TLS configuration conflicts with the connection URL');
      ssl = false;
    }
    // pg connection-string flags can otherwise replace a caller's trusted TLS settings.
    for (const key of ['ssl','sslmode','uselibpqcompat','sslcert','sslkey','sslrootcert']) uri.searchParams.delete(key);
    options.connectionString = uri.toString();
  }
  if (ssl !== undefined && ssl !== false) {
    if (ssl !== true && (typeof ssl !== 'object' || ssl === null || Array.isArray(ssl))) throw new Error('PostgreSQL TLS configuration is invalid');
    if (typeof ssl === 'object' && (ssl.rejectUnauthorized === false || ssl.checkServerIdentity !== undefined)) throw new Error('PostgreSQL TLS certificate verification must remain enabled');
    options.ssl = {...(ssl === true ? {} : ssl), rejectUnauthorized: true};
  } else if (ssl === false) options.ssl = false;
  if (!Number.isSafeInteger(options.max) || options.max < 1 || options.max > 50) throw new Error('PostgreSQL pool size is invalid');
  return options;
}

/** Tokenize SQL so parameter, alias and function changes never alter strings/comments. */
function sqlTokens(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('A SQL statement is required');
  const tokens = [];
  for (let i = 0; i < sql.length;) {
    const start = i, char = sql[i];
    if (/\s/u.test(char)) {while (i < sql.length && /\s/u.test(sql[i])) i++; tokens.push({kind:'space',text:sql.slice(start,i)}); continue;}
    if (sql.startsWith('--',i)) {i = sql.indexOf('\n',i); if (i === -1) i = sql.length; tokens.push({kind:'comment',text:sql.slice(start,i)}); continue;}
    if (sql.startsWith('/*',i)) {
      i += 2; let depth = 1;
      while (i < sql.length && depth) {if (sql.startsWith('/*',i)) {depth++; i += 2;} else if (sql.startsWith('*/',i)) {depth--; i += 2;} else i++;}
      if (depth) throw new Error('Unterminated SQL comment');
      tokens.push({kind:'comment',text:sql.slice(start,i)}); continue;
    }
    if (char === "'" || char === '"') {
      const escaped = char === "'" && /(?:^|[^A-Za-z_0-9])E$/iu.test(sql.slice(0,start));
      i++; let complete = false;
      while (i < sql.length) {if (escaped && sql[i] === '\\') {i += 2; continue;} if (sql[i++] === char) {if (sql[i] === char) i++; else {complete = true; break;}}}
      if (!complete) throw new Error('Unterminated SQL literal or identifier');
      tokens.push({kind:char === "'" ? 'literal' : 'quoted',text:sql.slice(start,i)}); continue;
    }
    if (char === '$') {
      const dollar = sql.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/u);
      if (dollar) {const end = sql.indexOf(dollar[0],i+dollar[0].length); if (end === -1) throw new Error('Unterminated SQL dollar literal'); i = end+dollar[0].length; tokens.push({kind:'literal',text:sql.slice(start,i)}); continue;}
      const parameter = sql.slice(i).match(/^\$\d+/u);
      if (parameter) {i += parameter[0].length; tokens.push({kind:'parameter',text:parameter[0]}); continue;}
    }
    if (/[A-Za-z_]/u.test(char)) {i++; while (i < sql.length && /[A-Za-z_0-9$]/u.test(sql[i])) i++; tokens.push({kind:'word',text:sql.slice(start,i)}); continue;}
    i++; tokens.push({kind:'symbol',text:char});
  }
  return tokens;
}
const significant = tokens => tokens.map((token,index) => ({token,index})).filter(({token}) => !['space','comment'].includes(token.kind));
function scalarFunctions(tokens) {
  const output = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind !== 'word' || !['MAX','MIN'].includes(token.text.toUpperCase())) {output.push(token.text); continue;}
    let open = i+1; while (open < tokens.length && ['space','comment'].includes(tokens[open].kind)) open++;
    if (tokens[open]?.text !== '(') {output.push(token.text); continue;}
    let depth = 1, begin = open+1, close = open+1; const args = [];
    for (; close < tokens.length; close++) {
      if (tokens[close].text === '(') depth++;
      else if (tokens[close].text === ')') {if (--depth === 0) break;}
      else if (tokens[close].text === ',' && depth === 1) {args.push(tokens.slice(begin,close)); begin = close+1;}
    }
    if (depth) throw new Error('Unbalanced SQL function');
    if (!args.length) {output.push(token.text); continue;} // Aggregate MAX/MIN remains unchanged.
    args.push(tokens.slice(begin,close));
    const expressions = args.map(scalarFunctions);
    const fn = token.text.toUpperCase() === 'MAX' ? 'GREATEST' : 'LEAST';
    // SQLite scalar MAX/MIN propagates NULL; PostgreSQL GREATEST/LEAST alone does not.
    output.push(`(CASE WHEN ${expressions.map(expression => `(${expression}) IS NULL`).join(' OR ')} THEN NULL ELSE ${fn}(${expressions.join(',')}) END)`);
    i = close;
  }
  return output.join('');
}

export function postgresSql(sql) {
  const tokens = sqlTokens(sql);
  const words = significant(tokens);
  const nativeParameters = words.some(({token}) => token.kind === 'parameter');
  if (words.some(({token}) => token.kind === 'word' && token.text.toUpperCase() === 'PRAGMA')) throw new Error('SQLite PRAGMA is not valid for PostgreSQL');
  let placeholders = 0;
  for (const token of tokens) if (token.kind === 'symbol' && token.text === '?') {token.kind = 'parameter'; token.text = `$${++placeholders}`;}
  if (placeholders && nativeParameters) throw new Error('Mixed SQL parameter styles are not supported');
  for (const token of tokens) if (token.kind === 'word' && token.text.toUpperCase() === 'LIKE') token.text = 'ILIKE';
  // Unquoted PostgreSQL aliases are lowercased; existing API aliases must retain camelCase.
  for (let i = 0; i+1 < words.length; i++) {
    if (words[i].token.kind === 'word' && words[i].token.text.toUpperCase() === 'AS' && words[i+1].token.kind === 'word' && /[A-Z]/u.test(words[i+1].token.text) && /[a-z]/u.test(words[i+1].token.text)) {
      words[i+1].token.text = `"${words[i+1].token.text}"`;
      words[i+1].token.kind = 'quoted';
    }
  }
  const ignore = words.length >= 4 && ['INSERT','OR','IGNORE','INTO'].every((word,index) => words[index].token.kind === 'word' && words[index].token.text.toUpperCase() === word);
  if (ignore) {words[1].token.text = ''; words[2].token.text = '';}
  let result = scalarFunctions(tokens);
  if (ignore) {
    if (words.some(({token}) => token.kind === 'word' && token.text.toUpperCase() === 'CONFLICT')) throw new Error('INSERT OR IGNORE cannot contain another conflict clause');
    const returning = words.find(({token}) => token.kind === 'word' && token.text.toUpperCase() === 'RETURNING');
    if (returning) throw new Error('INSERT OR IGNORE with RETURNING is not supported');
    // The business use is a single INSERT; reject appended statements instead of rewriting them.
    const semicolons = significant(tokens).filter(({token}) => token.text === ';');
    if (semicolons.length > 1 || semicolons.length === 1 && significant(tokens).at(-1).token.text !== ';') throw new Error('INSERT OR IGNORE requires a single SQL statement');
    result = appendClause(result,'ON CONFLICT DO NOTHING');
  }
  return {text:result, placeholders};
}

function appendClause(sql, clause) {
  const tokens = sqlTokens(sql), words = significant(tokens);
  const last = words.at(-1);
  if (!last) throw new Error('A SQL statement is required');
  tokens.splice(last.index+(last.token.text === ';' ? 0 : 1),0,{kind:'word',text:` ${clause}`});
  return tokens.map(token => token.text).join('');
}

function normalizedDefinition(sql) {
  if (sql === null || sql === undefined) return null;
  const tokens = significant(sqlTokens(sql)).map(({token}) => token);
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (i === 0 && token.kind === 'word' && token.text.toUpperCase() === 'CHECK') continue;
    if (token.kind === 'symbol' && ['(',')','[',']'].includes(token.text)) continue;
    if (token.text === ':' && tokens[i+1]?.text === ':' && tokens[i+2]?.kind === 'word' && ['TEXT','INTEGER','BIGINT'].includes(tokens[i+2].text.toUpperCase())) {i += 2; continue;}
    result.push(token.kind === 'word' ? token.text.toUpperCase() : token.text);
  }
  // pg_get_constraintdef renders IN constants as '= ANY (ARRAY[...])'.
  for (let i = 0; i+2 < result.length; i++) {
    if (result[i] === '=' && result[i+1] === 'ANY' && result[i+2] === 'ARRAY') result.splice(i,3,'IN');
  }
  return result.join('');
}

async function assertEmptyCopiedSchema(client, schema) {
  const fail = () => {throw new Error('Copied PostgreSQL schema is not a complete, empty version-8 or version-9 application schema');};
  const existing = await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[schema]);
  const names = new Set(existing.rows.map(row => row.tablename));
  const payment=names.has('payment_orders'),copiedVersion=payment?9:8;
  const tableNames = [...APPLICATION_TABLES.filter(name=>name!=='payment_orders'||payment),'schema_metadata'];
  const columnContract={...SCHEMA_8_COLUMNS,...(payment?{payment_orders:PAYMENT_COLUMNS}:{})};
  const primaryContract={...SCHEMA_8_PRIMARY,...(payment?{payment_orders:'id'}:{})};
  const uniqueContract={...SCHEMA_8_UNIQUE,...(payment?{payment_orders:['owner_id,idempotency_hash','environment,trade_no']}:{})};
  const foreignContract={...SCHEMA_8_FOREIGN,...(payment?{payment_orders:{owner_id:'users.id'}}:{})};
  const checkContract={...SCHEMA_8_CHECKS,...(payment?{payment_orders:PAYMENT_CHECKS}:{})};
  const indexContract={...SCHEMA_8_INDEXES,...(payment?{payment_orders_owner:['payment_orders','owner_id,created_at'],payment_orders_pending:['payment_orders','status,expires_at']}:{})};
  if (tableNames.some(name => !names.has(name))) fail();
  const columns = await client.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,is_identity,identity_generation
    FROM information_schema.columns WHERE table_schema=$1 AND table_name=ANY($2::text[])`,[schema,tableNames]);
  for (const [table,specification] of Object.entries(columnContract)) {
    const actual = columns.rows.filter(row => row.table_name === table);
    const expected = specification.split(' ').map(column => {const [name,type] = column.split(':'); return {name,type:type.replace(/\?$/u,''),nullable:type.endsWith('?')};});
    if (actual.length !== expected.length) fail();
    for (const column of expected) {
      const row = actual.find(value => value.column_name === column.name), key = `${table}.${column.name}`;
      if (!row || row.data_type !== column.type || row.is_nullable !== (column.nullable ? 'YES' : 'NO')) fail();
      if (normalizedDefinition(row.column_default) !== normalizedDefinition(SCHEMA_8_DEFAULTS[key] ?? null)) fail();
      if (key === 'audit.id') {if (row.is_identity !== 'YES' || row.identity_generation !== 'BY DEFAULT') fail();}
      else if (row.is_identity !== 'NO') fail();
    }
  }
  const constraints = await client.query(`SELECT t.relname AS table_name,c.contype,c.condeferrable,c.condeferred,c.convalidated,
    c.confdeltype,c.confupdtype,c.confmatchtype,rt.relname AS target_table,rn.nspname AS target_schema,
    ARRAY(SELECT a.attname::text FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum,pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum ORDER BY k.pos) AS columns,
    ARRAY(SELECT a.attname::text FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum,pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum ORDER BY k.pos) AS target_columns,
    pg_catalog.pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_class t ON t.oid=c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace
    LEFT JOIN pg_catalog.pg_class rt ON rt.oid=c.confrelid LEFT JOIN pg_catalog.pg_namespace rn ON rn.oid=rt.relnamespace
    WHERE n.nspname=$1 AND t.relname=ANY($2::text[]) AND c.contype<>'n'`,[schema,tableNames]);
  const expected = new Set(), actual = new Set();
  for (const [table,primary] of Object.entries(primaryContract)) expected.add(`p|${table}|${primary}`);
  for (const [table,unique] of Object.entries(uniqueContract)) for (const columns of unique) expected.add(`u|${table}|${columns}`);
  for (const [table,foreign] of Object.entries(foreignContract)) for (const [column,target] of Object.entries(foreign)) expected.add(`f|${table}|${column}|${target}`);
  for (const [table,checks] of Object.entries(checkContract)) for (const check of checks) expected.add(`c|${table}|${normalizedDefinition(check)}`);
  for (const row of constraints.rows) {
    if (row.condeferrable || row.condeferred || !row.convalidated) fail();
    if (row.contype === 'p' || row.contype === 'u') actual.add(`${row.contype}|${row.table_name}|${row.columns.join(',')}`);
    else if (row.contype === 'f') {
      if (row.target_schema !== schema || row.confdeltype !== 'a' || row.confupdtype !== 'a' || row.confmatchtype !== 's') fail();
      actual.add(`f|${row.table_name}|${row.columns.join(',')}|${row.target_table}.${row.target_columns.join(',')}`);
    } else if (row.contype === 'c') actual.add(`c|${row.table_name}|${normalizedDefinition(row.definition)}`);
    else fail();
  }
  if (expected.size !== actual.size || [...expected].some(value => !actual.has(value))) fail();
  const indexes = await client.query(`SELECT t.relname AS table_name,i.relname AS index_name,x.indisunique,x.indisprimary,x.indisvalid,x.indisready,
    ARRAY(SELECT a.attname::text FROM unnest(x.indkey::smallint[]) WITH ORDINALITY AS k(attnum,pos)
      JOIN pg_catalog.pg_attribute a ON a.attrelid=x.indrelid AND a.attnum=k.attnum
      WHERE k.pos<=x.indnkeyatts ORDER BY k.pos) AS columns,
    pg_catalog.pg_get_expr(x.indpred,x.indrelid,true) AS predicate,pg_catalog.pg_get_expr(x.indexprs,x.indrelid,true) AS expressions
    FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid=x.indrelid JOIN pg_catalog.pg_class i ON i.oid=x.indexrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname=$1 AND t.relname=ANY($2::text[])`,[schema,tableNames]);
  for (const [name,[table,columns,unique=false,predicate=null]] of Object.entries(indexContract)) {
    const index = indexes.rows.find(row => row.index_name === name);
    if (!index || index.table_name !== table || index.columns.join(',') !== columns || index.indisunique !== unique || index.expressions || !index.indisvalid || !index.indisready || normalizedDefinition(index.predicate) !== normalizedDefinition(predicate)) fail();
  }
  for (const index of indexes.rows.filter(row => row.indisunique)) {
    const columns = index.columns.join(',');
    if (index.expressions || !index.indisvalid || !index.indisready) fail();
    if (index.table_name === 'users' && columns === 'phone_number' && normalizedDefinition(index.predicate) === normalizedDefinition('phone_number IS NOT NULL')) continue;
    if (index.predicate || !(primaryContract[index.table_name] === columns || uniqueContract[index.table_name]?.includes(columns))) fail();
  }
  const populated = await client.query(tableNames.map(name => `SELECT '${name}' AS table_name WHERE EXISTS(SELECT 1 FROM "${name}")`).join(' UNION ALL '));
  if (populated.rows.length) fail();
  return copiedVersion;
}

const BASE_SCHEMA = `
CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user','admin')),disabled INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL);
CREATE TABLE sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),family_id TEXT NOT NULL,client_id TEXT NOT NULL,
  access_hash TEXT NOT NULL UNIQUE,refresh_hash TEXT NOT NULL UNIQUE,access_expires BIGINT NOT NULL,refresh_expires BIGINT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL);
CREATE INDEX sessions_family ON sessions(family_id);
CREATE TABLE used_refresh(token_hash TEXT PRIMARY KEY,family_id TEXT NOT NULL,expires_at BIGINT NOT NULL);
CREATE TABLE imports(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),filename TEXT NOT NULL,format TEXT NOT NULL,
  file_sha TEXT NOT NULL,preview TEXT NOT NULL,created_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,committed_bank_id TEXT,
  committed_version TEXT,title TEXT NOT NULL,revision INTEGER NOT NULL,status TEXT NOT NULL,source BYTEA NOT NULL,warnings TEXT NOT NULL);
CREATE INDEX imports_owner ON imports(owner_id,created_at);
CREATE TABLE banks(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),title TEXT NOT NULL,current_version TEXT NOT NULL,
  sequence INTEGER NOT NULL,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL);
CREATE INDEX banks_owner ON banks(owner_id,updated_at);
CREATE TABLE private_versions(bank_id TEXT NOT NULL REFERENCES banks(id),data_version TEXT NOT NULL,sequence INTEGER NOT NULL,
  payload TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes BIGINT NOT NULL,question_count INTEGER NOT NULL,created_at BIGINT NOT NULL,
  PRIMARY KEY(bank_id,data_version));
CREATE TABLE confirmations(owner_id TEXT NOT NULL REFERENCES users(id),idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,
  result TEXT NOT NULL,PRIMARY KEY(owner_id,idempotency_key));
CREATE TABLE reviews(id TEXT PRIMARY KEY,bank_id TEXT NOT NULL REFERENCES banks(id),data_version TEXT NOT NULL,
  reviewer_id TEXT NOT NULL REFERENCES users(id),decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),note TEXT NOT NULL,created_at BIGINT NOT NULL);
CREATE TABLE releases(id TEXT PRIMARY KEY,public_bank_id TEXT NOT NULL,data_version TEXT NOT NULL UNIQUE,release_sequence INTEGER NOT NULL UNIQUE,
  source_bank_id TEXT NOT NULL REFERENCES banks(id),source_version TEXT NOT NULL,review_id TEXT NOT NULL REFERENCES reviews(id),
  publisher_id TEXT NOT NULL REFERENCES users(id),payload TEXT NOT NULL,sha256 TEXT NOT NULL,size_bytes BIGINT NOT NULL,
  question_count INTEGER NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('published','withdrawn')),
  created_at BIGINT NOT NULL,withdrawn_at BIGINT,UNIQUE(source_bank_id,source_version));
CREATE INDEX releases_state ON releases(state,public_bank_id,release_sequence);
CREATE TABLE audit(id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,target_id TEXT NOT NULL,
  details TEXT NOT NULL,created_at BIGINT NOT NULL);
`;

const MIGRATIONS = {
  2: `ALTER TABLE users ADD COLUMN phone_number TEXT;
ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN last_login_at BIGINT;
ALTER TABLE users ADD COLUMN membership TEXT NOT NULL DEFAULT 'free';
ALTER TABLE users ADD COLUMN membership_expires BIGINT;
ALTER TABLE users ADD COLUMN trial_started BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN trial_ends BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN points_balance BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN points_reserved BIGINT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;
UPDATE users SET trial_started=created_at,trial_ends=created_at+900000;
CREATE UNIQUE INDEX users_phone ON users(phone_number) WHERE phone_number IS NOT NULL;
CREATE TABLE points_ledger(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),delta BIGINT NOT NULL,
  balance_before BIGINT NOT NULL,balance_after BIGINT NOT NULL,reason TEXT NOT NULL,actor_id TEXT,idempotency_key TEXT NOT NULL,
  created_at BIGINT NOT NULL,UNIQUE(user_id,idempotency_key));
CREATE TABLE sms_challenges(id TEXT PRIMARY KEY,phone TEXT NOT NULL,code_hmac TEXT NOT NULL,expires_at BIGINT NOT NULL,
  used_at BIGINT,attempts INTEGER NOT NULL DEFAULT 0,created_at BIGINT NOT NULL,ip_hash TEXT NOT NULL,state TEXT NOT NULL);
CREATE INDEX sms_phone_time ON sms_challenges(phone,created_at);
CREATE INDEX sms_ip_time ON sms_challenges(ip_hash,created_at);
CREATE TABLE sms_failures(phone TEXT NOT NULL,created_at BIGINT NOT NULL);
CREATE TABLE models(id TEXT PRIMARY KEY,config TEXT NOT NULL,encrypted_key TEXT,key_fingerprint TEXT,revision INTEGER NOT NULL,
  last_test_at BIGINT,last_test_status TEXT,last_test_error TEXT,last_test_result TEXT,created_at BIGINT NOT NULL);
CREATE TABLE model_tests(id TEXT PRIMARY KEY,model_id TEXT NOT NULL REFERENCES models(id),actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,result TEXT,created_at BIGINT NOT NULL,UNIQUE(actor_id,idempotency_key));
CREATE TABLE announcements(id TEXT PRIMARY KEY,title TEXT NOT NULL,body TEXT NOT NULL,version INTEGER NOT NULL,status TEXT NOT NULL,
  audience TEXT NOT NULL,published_at BIGINT,starts_at BIGINT,ends_at BIGINT,created_at BIGINT NOT NULL);
CREATE TABLE announcement_dismissals(user_id TEXT NOT NULL REFERENCES users(id),announcement_id TEXT NOT NULL REFERENCES announcements(id),
  version INTEGER NOT NULL,created_at BIGINT NOT NULL,PRIMARY KEY(user_id,announcement_id,version));`,
  3: "ALTER TABLE imports ADD COLUMN summary TEXT NOT NULL DEFAULT '{}';",
  4: `ALTER TABLE sms_challenges ADD COLUMN provider TEXT NOT NULL DEFAULT 'local';
ALTER TABLE sms_challenges ADD COLUMN issuer TEXT;
ALTER TABLE sms_challenges ADD COLUMN attempt_nonce TEXT;
CREATE TABLE external_phone_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  phone TEXT NOT NULL,verified_at BIGINT NOT NULL,PRIMARY KEY(issuer,subject));`,
  5: `ALTER TABLE sms_challenges ADD COLUMN purpose TEXT NOT NULL DEFAULT 'registration';
ALTER TABLE sms_challenges ADD COLUMN target_user_id TEXT;
CREATE INDEX sms_target_purpose ON sms_challenges(target_user_id,purpose,created_at);`,
  6: 'ALTER TABLE banks ADD COLUMN deleted_at BIGINT;',
  7: "ALTER TABLE banks ADD COLUMN description TEXT NOT NULL DEFAULT '';",
  8: `ALTER TABLE users ADD COLUMN avatar_id TEXT;
CREATE TABLE ai_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),session_id TEXT NOT NULL REFERENCES sessions(id),
  idempotency_hash TEXT NOT NULL,request_hash TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN ('builtin','byok')),
  model_id TEXT REFERENCES models(id),model_revision INTEGER,catalog_key TEXT,points_cost BIGINT NOT NULL CHECK(points_cost>=0),
  status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),result TEXT,error_code TEXT,error_message TEXT,http_status INTEGER,
  created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,expires_at BIGINT NOT NULL,UNIQUE(user_id,idempotency_hash));
CREATE INDEX ai_requests_pending ON ai_requests(status,expires_at);
CREATE INDEX ai_requests_user_time ON ai_requests(user_id,created_at);
CREATE INDEX ai_requests_model_time ON ai_requests(model_id,created_at);`,
  9: `CREATE TABLE payment_orders(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL REFERENCES users(id),
idempotency_hash TEXT NOT NULL,request_hash TEXT NOT NULL,environment TEXT NOT NULL CHECK(environment IN ('sandbox','production')),
app_id TEXT NOT NULL,seller_id TEXT NOT NULL,package_id TEXT NOT NULL,package_title TEXT NOT NULL,
amount_minor BIGINT NOT NULL CHECK(amount_minor>0),points BIGINT NOT NULL CHECK(points>0),
status TEXT NOT NULL CHECK(status IN ('creating','pending','uncertain','failed','paid','closed')),
qr_code TEXT,trade_no TEXT,receipt_hash TEXT,error_code TEXT,created_at BIGINT NOT NULL,updated_at BIGINT NOT NULL,
 expires_at BIGINT NOT NULL,precreate_at BIGINT NOT NULL,checked_at BIGINT,paid_at BIGINT,
UNIQUE(owner_id,idempotency_hash),UNIQUE(environment,trade_no));
CREATE INDEX payment_orders_owner ON payment_orders(owner_id,created_at);
CREATE INDEX payment_orders_pending ON payment_orders(status,expires_at);`
};

export class PostgresStore {
  constructor(config) {
    this.schema = config?.schema ?? 'float_ai';
    if (typeof this.schema !== 'string' || !/^[a-z][a-z0-9_]{0,62}$/u.test(this.schema) || ['public','pg_catalog','information_schema'].includes(this.schema) || this.schema.startsWith('pg_')) throw new Error('A dedicated PostgreSQL application schema is required');
    this.pool = new Pool(connectionOptions(config));
    this.pool.on('error', () => {}); // Active queries surface their errors; never log connection credentials.
    this.kind = 'postgres';
    this._context = new AsyncLocalStorage();
    this._schemaVersion = 0;
    this._initPromise = null;
    this._closed = false;
  }
  static async open(config) {
    const store = new PostgresStore(config);
    try {await store.init(); return store;} catch (error) {await store.close(); throw error;}
  }
  get schemaVersion() {return this._schemaVersion;}
  async _client() {
    const client = await this.pool.connect();
    try {await client.query(`SET search_path TO "${this.schema}", pg_catalog`); return client;}
    catch (error) {client.release(error); throw error;}
  }
  async init() {
    if (this._closed) throw new Error('Database is closed');
    this._initPromise ??= this._initialize();
    await this._initPromise;
    return this;
  }
  async _initialize() {
    const client = await this._client(); let failed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1,$2)',[LOCK_NAMESPACE,WRITE_LOCK]);
      await client.query('SELECT pg_advisory_xact_lock($1,$2)',[LOCK_NAMESPACE,MIGRATION_LOCK]);
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
      const tables = await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[this.schema]);
      const names = new Set(tables.rows.map(row => row.tablename));
      if (!names.has('schema_metadata') && APPLICATION_TABLES.some(name => names.has(name))) throw new Error('Existing PostgreSQL business tables have no schema marker; explicit migration is required');
      if (!names.has('schema_metadata')) {
        await client.query('CREATE TABLE schema_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),version INTEGER NOT NULL,updated_at BIGINT NOT NULL)');
        await client.query('INSERT INTO schema_metadata(singleton,version,updated_at) VALUES(1,0,$1)',[Date.now()]);
      }
      let marker = (await client.query('SELECT version FROM schema_metadata WHERE singleton=1 FOR UPDATE')).rows[0];
      if (!marker) {
        const copiedVersion=await assertEmptyCopiedSchema(client,this.schema);
        await client.query('INSERT INTO schema_metadata(singleton,version,updated_at) VALUES(1,$1,$2)',[copiedVersion,Date.now()]);
        marker = {version:copiedVersion};
      }
      if (!marker || !Number.isSafeInteger(marker.version) || marker.version < 0) throw new Error('PostgreSQL schema marker is invalid');
      if (marker.version > SCHEMA_VERSION) throw new Error('Database schema is newer than this server');
      let version = marker.version;
      if (version === 0) {await client.query(BASE_SCHEMA); version = 1;}
      for (let next = version+1; next <= SCHEMA_VERSION; next++) {
        await client.query(MIGRATIONS[next]);
        if (next === 3) {
          const imports = await client.query('SELECT id,preview FROM imports');
          for (const row of imports.rows) {
            const items = JSON.parse(row.preview);
            const summary = {questionCount:items.length,errorCount:items.reduce((n,q) => n+q.errors.length,0)};
            await client.query('UPDATE imports SET summary=$1 WHERE id=$2',[JSON.stringify(summary),row.id]);
          }
        }
      }
      await client.query('UPDATE schema_metadata SET version=$1,updated_at=$2 WHERE singleton=1',[SCHEMA_VERSION,Date.now()]);
      const completed = await client.query('SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname=$1',[this.schema]);
      const completedNames = new Set(completed.rows.map(row => row.tablename));
      if (APPLICATION_TABLES.some(name => !completedNames.has(name))) throw new Error('PostgreSQL application schema is incomplete');
      await client.query('COMMIT');
      this._schemaVersion = SCHEMA_VERSION;
    } catch (error) {
      try {await client.query('ROLLBACK');} catch {failed = true;}
      throw error;
    } finally {client.release(failed);}
  }
  async _usingClient(fn, write = false) {
    const context = this._context.getStore();
    if (context) {
      return this._scoped(context, () => fn(context.client));
    }
    await this.init();
    if (this._closed) throw new Error('Database is closed');
    if (write) return this.transaction(() => fn(this._context.getStore().client));
    const client = await this._client();
    try {return await fn(client);} finally {client.release();}
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
  _statement(sql, params) {
    const compiled = postgresSql(sql);
    if (compiled.placeholders && compiled.placeholders !== params.length) throw new Error('SQL parameter count does not match');
    for (const value of params) if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new RangeError('Database numeric parameters must be safe integers');
    for (const value of params) if (typeof value === 'bigint' && !Number.isSafeInteger(Number(value))) throw new RangeError('Database bigint parameters must fit the safe application range');
    return {text:compiled.text,values:params.map(value => value instanceof Uint8Array && !Buffer.isBuffer(value) ? Buffer.from(value) : value)};
  }
  async get(sql, ...params) {const statement = this._statement(sql,params); return this._usingClient(async client => (await client.query(statement)).rows[0]);}
  async all(sql, ...params) {const statement = this._statement(sql,params); return this._usingClient(async client => (await client.query(statement)).rows);}
  async run(sql, ...params) {
    const statement = this._statement(sql,params);
    const tokens = significant(sqlTokens(statement.text));
    const insertAudit = tokens[0]?.token.text.toUpperCase() === 'INSERT' && tokens[1]?.token.text.toUpperCase() === 'INTO' && tokens[2]?.token.text.toLowerCase() === 'audit';
    if (insertAudit && !tokens.some(({token}) => token.kind === 'word' && token.text.toUpperCase() === 'RETURNING')) statement.text = appendClause(statement.text,'RETURNING id');
    return this._usingClient(async client => {
      const result = await client.query(statement);
      return {changes:result.rowCount ?? 0,...(insertAudit && result.rows[0] ? {lastInsertRowid:result.rows[0].id} : {})};
    },true);
  }
  async exec(sql) {
    const compiled = postgresSql(sql);
    if (compiled.placeholders) throw new Error('Database exec does not accept placeholders');
    let statementStart = true;
    for (const {token} of significant(sqlTokens(compiled.text))) {
      if (statementStart && token.kind === 'word' && ['BEGIN','START','END','COMMIT','ROLLBACK','SAVEPOINT','RELEASE'].includes(token.text.toUpperCase())) throw new Error('Use the database transaction API');
      statementStart = token.text === ';';
    }
    return this._usingClient(async client => {await client.query(compiled.text);},true);
  }
  async transaction(fn) {
    if (typeof fn !== 'function') throw new TypeError('A database transaction callback is required');
    const parent = this._context.getStore();
    if (parent) return this._scoped(parent, async () => {
      const name = `float_ai_savepoint_${++parent.root.savepoint}`;
      const context = {client:parent.client,active:true,tail:Promise.resolve(),root:parent.root};
      await parent.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await this._context.run(context,fn);
        await context.tail;
        context.active = false;
        await parent.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (error) {
        context.active = false;
        await context.tail;
        try {await parent.client.query(`ROLLBACK TO SAVEPOINT ${name}`); await parent.client.query(`RELEASE SAVEPOINT ${name}`);}
        catch {parent.root.failed = true;}
        throw error;
      } finally {context.active = false;}
    });
    await this.init();
    if (this._closed) throw new Error('Database is closed');
    const client = await this._client(); const context = {client,active:true,tail:Promise.resolve(),root:{savepoint:0,failed:false}}; let failed = false;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1,$2)',[LOCK_NAMESPACE,WRITE_LOCK]);
      const result = await this._context.run(context,fn);
      await context.tail;
      context.active = false;
      if (context.root.failed) throw new Error('Database transaction savepoint recovery failed');
      await client.query('COMMIT');
      return result;
    } catch (error) {
      context.active = false;
      await context.tail;
      try {await client.query('ROLLBACK');} catch {failed = true;}
      throw error;
    } finally {context.active = false; client.release(failed);}
  }
  async audit(actor, action, target, details = {}) {
    return this.run('INSERT INTO audit(actor_id,action,target_id,details,created_at) VALUES(?,?,?,?,?)',
      actor, action, target, JSON.stringify(details), Date.now());
  }
  async close() {
    if (this._context.getStore()) throw new Error('Cannot close a database inside a transaction');
    if (this._closed) return;
    this._closed = true;
    if (this._initPromise) try {await this._initPromise;} catch {}
    await this.pool.end();
  }
}
