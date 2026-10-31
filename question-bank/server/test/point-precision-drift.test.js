import test from 'node:test';
import assert from 'node:assert/strict';
import {PostgresStore} from '../src/postgres-store.js';
import {ensurePostgresPointPrecision} from '../src/point-precision-migration.js';

const tableNames=['users','sessions','used_refresh','imports','banks','private_versions','confirmations','reviews','releases','audit','points_ledger','sms_challenges','sms_failures','models','model_tests','announcements','announcement_dismissals','external_phone_identities','ai_requests','payment_orders','user_feedback','app_promotions','schema_metadata'];
const names={users:['points_balance','points_reserved'],points_ledger:['delta','balance_before','balance_after'],ai_requests:['points_cost']};
function fixture({version=11,precise=false,live=false,invalid=false,corrupt=false,mixed=false,badScale=false,postGuard=false}={}){
  const log=[],types=new Map(Object.keys(names).map(name=>[name,precise?'numeric':'bigint']));
  if(mixed)types.set('users','numeric');
  let altered=false,marker=version;
  const tables=new Set(version===9?tableNames.filter(name=>!['user_feedback','app_promotions'].includes(name)):tableNames);
  const snapshots={
    users:[{id:'synthetic-user',points_balance:10000,points_reserved:0}],
    points_ledger:[{id:'synthetic-ledger',delta:10000,balance_before:0,balance_after:10000}],
    ai_requests:[{id:'synthetic-request',points_cost:20}]
  };
  const client={release(){},async query(sql,params=[]){
    log.push({sql,params});
    if(sql.includes('FROM pg_catalog.pg_tables'))return {rows:[...tables].map(tablename=>({tablename}))};
    if(sql.startsWith('SELECT version FROM schema_metadata'))return {rows:[{version:marker}]};
    if(sql.includes('information_schema.columns'))return {rows:Object.entries(names).flatMap(([table_name,columns])=>columns.map(column_name=>({
      table_name,column_name,data_type:types.get(table_name),numeric_precision:types.get(table_name)==='numeric'?18:64,numeric_scale:types.get(table_name)==='numeric'?(badScale?3:2):0
    })))};
    if(sql.includes('SELECT COUNT(*)'))return {rows:[{n:live?1:0}]};
    if(sql.startsWith('SELECT 1')&&sql.includes('ABS('))return {rows:invalid?[{invalid:1}]:[]};
    if(sql.startsWith('SELECT id,CAST(')){
      const table=/ FROM (\w+) ORDER BY id/u.exec(sql)?.[1];
      const rows=structuredClone(snapshots[table]);
      if(corrupt&&altered&&table==='users')rows[0].points_balance--;
      return {rows};
    }
    if(sql.startsWith('ALTER TABLE ')){types.set(/^ALTER TABLE (\w+)/u.exec(sql)[1],'numeric');altered=true;}
    if(sql.startsWith('CREATE TABLE user_feedback')){tables.add('user_feedback');tables.add('app_promotions');}
    if(sql.startsWith('UPDATE schema_metadata'))marker=params[0];
    return {rows:[]};
  }};
  const store=Object.create(PostgresStore.prototype);
  store.schema='synthetic';store._client=async()=>client;
  let structureChecks=0;
  // The live schema guard is independently checked by the read-only audit;
  // here isolate initialization order, DDL, and transaction failure handling.
  store._verifyPointRepairStructure=async()=>{structureChecks++;if(postGuard&&structureChecks===2)throw new Error('POINTS_PRECISION_SCHEMA_INVALID');};
  return {client,store,log,types,marker:()=>marker,structureChecks:()=>structureChecks};
}

test('real Postgres initializer repairs known BIGINT drift even when marker already equals 11',async()=>{
  const f=fixture();await f.store._initialize();
  assert.equal(f.store.schemaVersion,11);assert.equal(f.marker(),11);assert.equal(f.structureChecks(),2);
  const ddl=f.log.filter(x=>x.sql.startsWith('ALTER TABLE'));
  assert.equal(ddl.length,3);assert(ddl.every(x=>x.sql.includes('NUMERIC(18,2)')&&!x.sql.includes('*100')));
  assert.equal(f.log.at(-1).sql,'COMMIT');
  assert(f.log.findIndex(x=>x.sql.startsWith('UPDATE schema_metadata'))>f.log.findLastIndex(x=>x.sql.startsWith('ALTER TABLE')));
  assert(!f.log.some(x=>/^(?:UPDATE (?:users|points_ledger|ai_requests)|DELETE|INSERT)/u.test(x.sql)));
});
test('healthy precise schema initializes without repair locks or monetary DDL',async()=>{
  const f=fixture({precise:true});await f.store._initialize();
  assert.equal(f.structureChecks(),0);assert(!f.log.some(x=>x.sql.startsWith('ALTER TABLE')||x.sql.startsWith('LOCK TABLE')));
  assert.equal(f.log.at(-1).sql,'COMMIT');
});
test('DEV marker9 applies the actual missing migrations before advancing marker11',async()=>{
  const f=fixture({version:9});await f.store._initialize();
  assert(f.log.some(x=>x.sql.startsWith('CREATE TABLE user_feedback')));
  assert.equal(f.marker(),11);assert.equal(f.store.schemaVersion,11);assert.equal(f.structureChecks(),0);
  assert.equal(f.log.at(-1).sql,'COMMIT');
});
test('live requests, invalid amounts or failed full-structure guard abort without ALTER',async()=>{
  for(const options of [{live:true},{invalid:true},{guard:true}]){
    const f=fixture(options);
    if(options.guard)f.store._verifyPointRepairStructure=async()=>{throw new Error('POINTS_PRECISION_SCHEMA_INVALID');};
    await assert.rejects(()=>f.store._initialize());
    assert.equal(f.log.at(-1).sql,'ROLLBACK');assert(!f.log.some(x=>x.sql.startsWith('ALTER TABLE')));
  }
});
test('mixed or unsupported precision is rejected rather than silently adopted',async()=>{
  for(const options of [{mixed:true},{precise:true,badScale:true}]){
    const f=fixture(options);
    await assert.rejects(()=>ensurePostgresPointPrecision(f.client,'synthetic'),e=>e.code==='POINTS_PRECISION_SCHEMA_INVALID');
    assert(!f.log.some(x=>x.sql.startsWith('ALTER TABLE')));
  }
});
test('post-conversion financial or full-structure mismatch rolls the initializer transaction back',async()=>{
  for(const options of [{corrupt:true},{postGuard:true}]){
    const f=fixture(options);
    await assert.rejects(()=>f.store._initialize());
    assert.equal(f.log.at(-1).sql,'ROLLBACK');assert(!f.log.some(x=>x.sql==='COMMIT'||x.sql.startsWith('UPDATE schema_metadata')));
  }
});
test('future schema marker remains a hard failure without repair DDL',async()=>{
  const f=fixture({version:12});await assert.rejects(()=>f.store._initialize(),/newer/u);
  assert.equal(f.log.at(-1).sql,'ROLLBACK');assert(!f.log.some(x=>x.sql.startsWith('ALTER TABLE')));
});
