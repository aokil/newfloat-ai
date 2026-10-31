import test from 'node:test';
import assert from 'node:assert/strict';
import {testApp,register,call} from './helpers.js';
import {pointUnits,pointValue,pointsResponse} from '../src/point-values.js';
import {migrateSqlitePointPrecision,migratePostgresPointPrecision} from '../src/point-precision-migration.js';
import {officialModelSearch,modelConfig} from '../src/models.js';
import {modelSupportsImages} from '../src/ai-image.js';
import {PostgresStore} from '../src/postgres-store.js';

const fakeKey='synthetic-environment-key-not-a-real-credential';
const usage={prompt_tokens:8,completion_tokens:4,total_tokens:12};
const answer={answer:'A',explanation:'',usage};
const image={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xGQAAAAASUVORK5CYII='};
const specs=[
  ['baichuan-air','baichuan','Baichuan4-Air','https://api.baichuan-ai.com/v1',0.2],
  ['deepseek-flash','deepseek','deepseek-flash','https://api.deepseek.com',0.5],
  ['deepseek-pro','deepseek','deepseek-v4-pro','https://api.deepseek.com',2]
];
const configuration=([catalogKey,provider,modelId,baseUrl,pointsPerCall])=>({
  catalogKey,provider,modelId,baseUrl,pointsPerCall,execution:'official',displayName:'Synthetic '+catalogKey,
  capabilities:['text'],maxOutputTokens:2048,timeoutMs:25000,enabled:false
});
const exact=(app,method,url,token,payload,key)=>app.inject({method,url,
  headers:{authorization:'Bearer '+token,'x-float-points-precision':'2',...(key?{'idempotency-key':key}:{})},
  ...(payload===undefined?{}:{payload})});
async function fixture(t,balance=2,transport=async()=>answer,postgresParameters=false){
  let supplierCalls=0;
  const app=await testApp({baichuanApiKey:fakeKey,deepseekApiKey:fakeKey,
    modelTransport:async(_config,key)=>{assert.equal(key,fakeKey);return {status:'passed',usage,latencyMs:1};},
    aiTransport:async(config,key,...args)=>{supplierCalls++;assert.equal(key,fakeKey);return transport(config,...args);}});
  t.after(()=>app.close());
  if(postgresParameters){
    // Exercise the real production parameter compiler while SQLite executes the
    // isolated fixture. This is not a real PostgreSQL engine or production DB.
    for(const method of ['get','all','run']){
      const original=app.store[method].bind(app.store);
      app.store[method]=(sql,...params)=>{
        const statement=PostgresStore.prototype._statement.call(null,sql,params);
        return original(sql,...statement.values);
      };
    }
  }
  const owner=await register(app,'isolated-fractional-owner'),token=owner.accessToken;
  await app.store.run("UPDATE users SET role='admin',points_balance=?,points_reserved=0 WHERE id=?",balance,owner.principal.userId);
  for(const spec of specs){
    const input=configuration(spec);
    let r=await exact(app,'POST','/v1/admin/models',token,{...input,apiKey:fakeKey},'reject-key-'+spec[0]);assert.equal(r.statusCode,400,r.body);
    r=await exact(app,'POST','/v1/admin/models',token,input,'create-'+spec[0]);assert.equal(r.statusCode,200,r.body);
    const model=r.json();assert.equal(model.credentialSource,'environment');assert.equal(model.pointsPerCall,spec[4]);assert.equal(model.pointsPerCallUnits,pointUnits(spec[4]));assert(!r.body.includes(fakeKey));
    assert.equal((await app.store.get('SELECT encrypted_key FROM models WHERE id=?',model.id)).encrypted_key,null);
    r=await exact(app,'POST',`/v1/admin/models/${model.id}/test`,token,{expectedRevision:model.revision},'test-'+spec[0]);assert.equal(r.json().status,'passed',r.body);
    r=await exact(app,'PATCH',`/v1/admin/models/${model.id}`,token,{enabled:true,expectedRevision:model.revision},'enable-'+spec[0]);assert.equal(r.statusCode,200,r.body);
  }
  const search=(modelKey,key,extra={},precise=true)=>(precise?exact:call)(app,'POST','/v1/ai/search',token,{mode:'builtin',modelKey,question:'合成题\nA. 甲\nB. 乙',...extra},key);
  const user=()=>app.store.get('SELECT * FROM users WHERE id=?',owner.principal.userId);
  return {app,owner,token,search,user,calls:()=>supplierCalls};
}

test('hundredth arithmetic and response negotiation never round/truncate stored balances',()=>{
  for(const amount of [0,0.01,0.2,0.5,1,10.25,1e9,-0.2])assert.equal(pointValue(pointUnits(amount)),amount);
  for(const value of [0.001,0.1+0.2,NaN,Infinity,'0.2',1e9+1])assert.throws(()=>pointUnits(value));
  let units=100;for(let i=0;i<5;i++)units-=pointUnits(0.2);assert.equal(units,0);
  const input={account:{pointsBalance:1.7,pointsReserved:0.5,pointsAvailable:1.2},items:[{delta:-0.2,balanceAfter:1.2}]};
  const precise=pointsResponse(input,true),legacy=pointsResponse(precise,false);
  assert.equal(precise.account.pointsAvailableUnits,120);assert.equal(legacy.account.pointsAvailable,1);
  assert(!JSON.stringify(legacy).includes('Units'));assert(!JSON.stringify(legacy).includes('UnitScale'));
  assert.deepEqual(pointsResponse(precise,true),precise);assert.equal(input.account.pointsAvailable,1.2);
});

test('PostgreSQL parameter compiler accepts exact point decimals and retains integer/range checks',()=>{
  const compile=(values)=>PostgresStore.prototype._statement.call(null,'SELECT ?,?,?,?',values);
  const statement=compile([-0.2,0.5,9.8,1700000000123]);
  assert.deepEqual(statement.values,['-0.20','0.50','9.80',1700000000123]);
  assert.equal(statement.text,'SELECT $1,$2,$3,$4');
  for(const value of [0.001,0.1+0.2,NaN,Infinity,-Infinity,Number.MAX_SAFE_INTEGER+1,1000000000.01])
    assert.throws(()=>compile([value,0,0,0]));
  assert.deepEqual(compile([Number.MAX_SAFE_INTEGER,1,0,-2]).values,[Number.MAX_SAFE_INTEGER,1,0,-2]);
  assert.throws(()=>compile([BigInt(Number.MAX_SAFE_INTEGER)+1n,0,0,0]));
  assert(Buffer.isBuffer(compile([new Uint8Array([1,2]),0,0,0]).values[0]));
});

test('five 0.2 charges plus two 0.5 charges pass PostgreSQL parameter binding and settle exactly once at zero',async t=>{
  const f=await fixture(t,2,undefined,true);
  for(let i=1;i<=5;i++){
    const r=await f.search('baichuan-air','air-'+i);assert.equal(r.statusCode,200,r.body);
    assert.equal(r.json().pointsChargedUnits,20);assert.equal(r.json().pointsAvailableUnits,200-i*20);
  }
  for(let i=1;i<=2;i++){
    const r=await f.search('deepseek-flash','flash-'+i,{thinking:false});assert.equal(r.statusCode,200,r.body);
    assert.equal(r.json().pointsCharged,0.5);assert.equal(r.json().pointsAvailableUnits,100-i*50);
  }
  let r=await f.search('baichuan-air','air-1');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsAvailable,0);assert.equal(f.calls(),7);
  r=await exact(f.app,'GET','/v1/ai/receipt',f.token,undefined,'flash-2');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsChargedUnits,50);
  r=await f.search('deepseek-flash','flash-2',{thinking:true});assert.equal(r.statusCode,409,r.body);assert.equal(f.calls(),7);
  const user=await f.user();assert.equal(user.points_balance,0);assert.equal(user.points_reserved,0);
  const rows=await f.app.store.all("SELECT delta,balance_after FROM points_ledger WHERE user_id=? AND reason LIKE 'AI搜题%'",f.owner.principal.userId);
  assert.equal(rows.length,7);assert.equal(rows.reduce((sum,r)=>sum+pointUnits(r.delta),0),-200);
});

test('legacy calls cannot buy fractional models; integer calls keep the exact remainder',async t=>{
  const f=await fixture(t,2.7,undefined,true);
  let r=await call(f.app,'GET','/v1/models/catalog',f.token);assert(!r.json().items.some(m=>['baichuan-air','deepseek-flash'].includes(m.key)));
  r=await f.search('baichuan-air','legacy-block',{},false);assert.equal(r.statusCode,426,r.body);assert.equal(f.calls(),0);
  r=await exact(f.app,'GET','/v1/models/catalog',f.token);assert(r.json().items.some(m=>m.key==='baichuan-air'&&m.pointsPerCallUnits===20));
  r=await f.search('deepseek-pro','legacy-pro',{},false);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsAvailable,0);assert.equal((await f.user()).points_balance,0.7);
  r=await f.search('baichuan-air','new-air');assert.equal(r.json().pointsAvailable,0.5,r.body);
  r=await call(f.app,'GET','/v1/me/points-ledger',f.token);assert.equal(r.statusCode,426,r.body);assert.equal(r.json().error.code,'POINTS_PRECISION_REQUIRED');
  r=await exact(f.app,'GET','/v1/me/points-ledger',f.token);assert(r.json().items.some(item=>item.delta===-0.2&&item.deltaUnits===-20));
  r=await exact(f.app,'GET','/v1/me',f.token);assert.equal(r.json().account.pointsAvailable,0.5,r.body);
});

test('pending fractional reservations exclude double-spend; failure releases without a ledger charge',async t=>{
  const entered=Promise.withResolvers(),finish=Promise.withResolvers();let failing=false;
  const f=await fixture(t,0.6,async()=>{if(failing)throw new Error('TIMEOUT_UNKNOWN');entered.resolve();return finish.promise;},true);
  t.after(()=>finish.resolve(answer));
  const pending=f.search('baichuan-air','held').then(r=>r);
  await entered.promise;
  assert.equal((await f.user()).points_reserved,0.2);
  let r=await f.search('deepseek-flash','over-reservation');assert.equal(r.statusCode,402,r.body);assert.equal(f.calls(),1);
  finish.resolve(answer);r=await pending;assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsAvailable,0.4);
  failing=true;r=await f.search('baichuan-air','failed');assert.equal(r.statusCode,502,r.body);
  assert.equal((await f.user()).points_balance,0.4);assert.equal((await f.user()).points_reserved,0);
  r=await f.search('baichuan-air','failed');assert.equal(r.statusCode,502,r.body);assert.equal(f.calls(),2);
});

test('DeepSeek low/high + 4096, disabled thinking, Flash images and text-only Air/Pro match request contracts',async t=>{
  const original=globalThis.fetch,requests=[];let truncated=false;
  t.after(()=>{globalThis.fetch=original;});
  globalThis.fetch=async(url,options)=>{
    const body=JSON.parse(options.body);requests.push({url,body});
    return new Response(JSON.stringify({id:'synthetic-response',usage,
      choices:[{finish_reason:truncated?'length':'stop',message:{content:truncated?'':'{"answer":"A"}',reasoning_content:'not displayed'}}]}));
  };
  const flash=modelConfig(configuration(specs[1])),pro=modelConfig(configuration(specs[2])),air=modelConfig(configuration(specs[0]));
  await officialModelSearch({...flash,deepseekThinking:true},fakeKey,'合成题',image);
  assert.equal(requests[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].body.max_tokens,4096);assert.deepEqual(requests[0].body.thinking,{type:'enabled'});
  assert.equal(requests[0].body.reasoning_effort,'high');assert.equal(requests[0].body.stream,false);
  assert.match(requests[0].body.messages[1].content[1].image_url.url,/^data:image\/png;base64,/);
  await officialModelSearch(pro,fakeKey,'合成题');assert.deepEqual(requests[1].body.thinking,{type:'disabled'});assert(!('reasoning_effort' in requests[1].body));
  await officialModelSearch(air,fakeKey,'合成题');assert.equal(requests[2].body.model,'Baichuan4-Air');assert(!('thinking' in requests[2].body));
  for(const config of [air,pro])await assert.rejects(()=>officialModelSearch(config,fakeKey,'合成题',image),e=>e.code==='MODEL_IMAGE_UNSUPPORTED');
  assert.equal(requests.length,3);assert(modelSupportsImages('deepseek-flash'));assert.equal(modelSupportsImages('deepseek-v4-pro',['image']),false);
  for(const config of [flash,pro])for(const effort of ['low','high']){
    await officialModelSearch({...config,deepseekThinking:true,deepseekReasoningEffort:effort},fakeKey,'合成题');
    const body=requests.at(-1).body;assert.equal(body.max_tokens,4096);assert.equal(body.reasoning_effort,effort);assert.deepEqual(body.thinking,{type:'enabled'});
  }
  truncated=true;await assert.rejects(()=>officialModelSearch({...flash,deepseekThinking:true},fakeKey,'合成题'),/TRUNCATED_RESPONSE/);
});

test('DeepSeek effort is validated, bound to idempotency and omitted for off/legacy Boolean requests',async t=>{
  const requests=[];
  const f=await fixture(t,4,async config=>{requests.push({thinking:config.deepseekThinking,effort:config.deepseekReasoningEffort});return answer;});
  let r=await f.search('deepseek-flash','effort-light',{thinking:false});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().model.thinking,false);
  r=await f.search('deepseek-flash','effort-medium',{thinking:true,reasoningEffort:'low'});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().model.reasoningEffort,'low');
  r=await f.search('deepseek-flash','effort-medium',{thinking:true,reasoningEffort:'high'});assert.equal(r.statusCode,409,r.body);assert.equal(f.calls(),2);
  r=await f.search('deepseek-flash','effort-medium',{thinking:true,reasoningEffort:'low'});assert.equal(r.statusCode,200,r.body);assert.equal(f.calls(),2);
  for(const value of ['Light','medium','max','off',false,null]){
    r=await f.search('deepseek-flash','invalid-'+String(value),{thinking:true,reasoningEffort:value});assert.equal(r.statusCode,400,r.body);
  }
  r=await f.search('deepseek-flash','conflicting-off',{thinking:false,reasoningEffort:'low'});assert.equal(r.statusCode,400,r.body);
  r=await f.search('baichuan-air','unrelated-effort',{thinking:true,reasoningEffort:'low'});assert.equal(r.statusCode,400,r.body);
  r=await f.search('deepseek-pro','effort-high-legacy',{thinking:true});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().model.reasoningEffort,'high');
  r=await f.search('deepseek-pro','effort-high-legacy',{thinking:true});assert.equal(r.statusCode,200,r.body);assert.equal(f.calls(),3);
  assert.deepEqual(requests,[{thinking:false,effort:null},{thinking:true,effort:'low'},{thinking:true,effort:'high'}]);
  assert.equal((await f.user()).points_balance,1);assert.equal((await f.user()).points_reserved,0);
});

test('fractional admin adjustments validate, replay once and preserve the remainder for legacy adjustments',async t=>{
  const f=await fixture(t,0.5,undefined,true),url=`/v1/admin/users/${f.owner.principal.userId}/points-adjustments`;
  const body={delta:0.2,reason:'synthetic precision adjustment',expectedRevision:(await f.user()).revision};
  let r=await call(f.app,'POST',url,f.token,body,'old-fraction');assert.equal(r.statusCode,426,r.body);
  r=await exact(f.app,'POST',url,f.token,{...body,delta:0.125},'bad-scale');assert.equal(r.statusCode,400,r.body);
  r=await exact(f.app,'POST',url,f.token,body,'exact-adjust');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsBalanceUnits,70);
  r=await exact(f.app,'POST',url,f.token,body,'exact-adjust');assert.equal(r.statusCode,200,r.body);assert.equal((await f.user()).points_balance,0.7);
  r=await call(f.app,'POST',url,f.token,{...body,delta:1,expectedRevision:(await f.user()).revision},'old-whole');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsBalance,1);assert.equal((await f.user()).points_balance,1.7);
});

test('schema 11 migration preserves old amounts and refuses active or malformed reservations',async t=>{
  const f=await fixture(t,100);const store=f.app.store;
  await store.run("INSERT INTO ai_requests(id,user_id,session_id,idempotency_hash,request_hash,mode,points_cost,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,'builtin',1,'pending',1,1,?)",
    'synthetic-migration-request',f.owner.principal.userId,f.owner.session.sessionId,'synthetic-migrate-idem','synthetic-migrate-digest',Date.now()+60000);
  await store.run('UPDATE users SET points_reserved=1 WHERE id=?',f.owner.principal.userId);
  // The raw SQLite helper is synchronous; use the real adapter transaction to verify rollback.
  const raw=store.store;
  assert(raw,'test adapter exposes its isolated raw store');
  raw.db.exec('PRAGMA user_version=10');
  await assert.rejects(()=>store.transaction(()=>migrateSqlitePointPrecision(raw)),e=>e.code==='POINTS_PRECISION_MIGRATION_BUSY');
  assert.equal(raw.get('PRAGMA user_version').user_version,10);assert.equal((await f.user()).points_balance,100);
  await store.run('UPDATE ai_requests SET expires_at=1 WHERE id=?','synthetic-migration-request');
  await store.transaction(()=>migrateSqlitePointPrecision(raw));
  assert.equal(raw.get('PRAGMA user_version').user_version,11);assert.equal((await f.user()).points_balance,100);assert.equal((await f.user()).points_reserved,0);
  assert.equal((await store.get('SELECT error_code FROM ai_requests WHERE id=?','synthetic-migration-request')).error_code,'PROCESS_INTERRUPTED');
  raw.db.exec('PRAGMA user_version=10');await store.run('UPDATE users SET points_balance=0.125 WHERE id=?',f.owner.principal.userId);
  await assert.rejects(()=>store.transaction(()=>migrateSqlitePointPrecision(raw)),e=>e.code==='POINTS_PRECISION_DATA_INVALID');assert.equal(raw.get('PRAGMA user_version').user_version,10);
});

test('PostgreSQL migration SQL preserves amounts, validates precision and refuses live requests (mock adapter)',async()=>{
  let migrated=false,busy=false;const sql=[];
  const columns=()=>[['users','points_balance'],['users','points_reserved'],['points_ledger','delta'],['points_ledger','balance_before'],['points_ledger','balance_after'],['ai_requests','points_cost']]
    .map(([table_name,column_name])=>({table_name,column_name,data_type:migrated?'numeric':'bigint',numeric_precision:migrated?18:64,numeric_scale:migrated?2:0}));
  const client={async query(text){sql.push(text);if(text.includes('information_schema.columns'))return {rows:columns()};
    if(text.includes('COUNT(*)'))return {rows:[{n:busy?1:0}]};
    if(text.startsWith('ALTER TABLE'))migrated=true;return {rows:[]};}};
  await migratePostgresPointPrecision(client,'synthetic');
  assert.equal(sql.filter(s=>s.startsWith('ALTER TABLE')).length,3);
  assert(sql.filter(s=>s.startsWith('ALTER TABLE')).every(s=>s.includes('NUMERIC(18,2)')&&!s.includes('*100')));
  busy=true;sql.length=0;await assert.rejects(()=>migratePostgresPointPrecision(client,'synthetic'),e=>e.code==='POINTS_PRECISION_MIGRATION_BUSY');
  assert(!sql.some(s=>s.startsWith('ALTER TABLE')));
});
