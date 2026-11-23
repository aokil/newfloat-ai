import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {membershipAccount} from '../src/membership.js';
import {pointWallet} from '../src/point-wallet.js';
import {testApp,register,call} from './helpers.js';

const source='a'.repeat(64),job=n=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
async function fixture(t,points=20){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES('u','points-fixture','fixture','not-a-password','user',0,?)",points);
  return {store,members:membershipAccount(store),wallet:pointWallet(store)};
}
test('balance below ten points and old undisclosed prices cannot produce a new file ticket',async t=>{
  const f=await fixture(t,9.99);
  for(const price of [undefined,true,5])
    await assert.rejects(f.members.startImport('u',job(100),source,price),e=>e.code==='AI_IMPORT_PRICE_CONFIRMATION_REQUIRED');
  await assert.rejects(f.members.startImport('u',job(100),source,10),e=>e.code==='AI_IMPORT_POINTS_REQUIRED');
  assert.equal((await f.wallet.snapshot('u')).pointsAvailable,9.99);
  await assert.rejects(f.members.requireImport('u',job(100),source),e=>e.code==='AI_IMPORT_TICKET_REQUIRED');
});
test('failure or removal releases the same point hold once and cannot later consume the released job',async t=>{
  const f=await fixture(t);await f.members.startImport('u',job(100),source,10);
  const released=await f.members.finishImport('u',job(100),false);assert.equal(released.state,'released');assert.equal(released.pointsCharged,0);
  assert.deepEqual(await f.members.finishImport('u',job(100),false),released);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,20);
  await assert.rejects(f.members.finishImport('u',job(100),true),e=>e.code==='AI_IMPORT_JOB_RELEASED');
});
test('restarts and repeated start/finish recover original funding without charging twice',async t=>{
  const f=await fixture(t);const first=await f.members.startImport('u',job(100),source,10);
  const restored=membershipAccount(f.store,f.options);assert.deepEqual(await restored.startImport('u',job(100),source,false),first);
  const done=await restored.finishImport('u',job(100),true);assert.deepEqual(await restored.finishImport('u',job(100),true),done);
  assert.deepEqual(await restored.finishImport('u',job(100),false),done); // Removing a consumed result is not a refund.
  assert.deepEqual(await restored.startImport('u',job(100),source),done);
  assert.equal((await f.wallet.snapshot('u')).pointsBalance,10);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入题库'")).n,1);
  await assert.rejects(restored.startImport('u',job(100),'b'.repeat(64),10),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
});
test('competing file jobs cannot both reserve the last ten points',async t=>{
  const f=await fixture(t,10);
  const outcomes=await Promise.allSettled([100,101].map(n=>f.members.startImport('u',job(n),source,10)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected')[0].reason.code,'AI_IMPORT_POINTS_REQUIRED');
  const ticket=outcomes.find(r=>r.status==='fulfilled').value;assert.equal((await f.wallet.snapshot('u')).pointsAvailable,0);
  await f.members.finishImport('u',ticket.jobId,true);assert.equal((await f.wallet.snapshot('u')).pointsBalance,0);
});
test('HTTP returns the authenticated file price and blocks a fresh job after spending the final ten points',async t=>{
  const app=await testApp();t.after(()=>app.close());const user=await register(app,'points-http');
  const balance='/v1/memberships/ai-imports/quota',endpoint='/v1/memberships/ai-imports/'+job(100);
  assert.equal((await call(app,'GET',balance)).statusCode,401);
  const before=(await call(app,'GET',balance,user.accessToken)).json();
  assert.equal(before.pointsPerImport,10);assert.equal(before.pointsAvailable,10);assert.equal(before.validUntil,undefined);
  const request={sourceHash:source,acceptedPointsCost:10};
  const reserved=await call(app,'POST',endpoint+'/start',user.accessToken,request);
  assert.equal(reserved.statusCode,200,reserved.body);assert.equal(reserved.json().pointsReserved,10);
  const done=await call(app,'POST',endpoint+'/finish',user.accessToken,{success:true});
  assert.equal(done.json().pointsCharged,10);assert.equal(done.json().pointsAvailable,0);
  assert.equal((await call(app,'POST',endpoint+'/start',user.accessToken,request)).json().state,'consumed');
  const newFile=await call(app,'POST','/v1/memberships/ai-imports/'+job(101)+'/start',user.accessToken,request);
  assert.equal(newFile.statusCode,402);assert.equal(newFile.json().error.code,'AI_IMPORT_POINTS_REQUIRED');
  const me=(await call(app,'GET','/v1/me',user.accessToken)).json();assert.equal(me.account.entitlements.aiImportAllowed,false);
});
test('a ticket persistence failure rolls back the wallet hold rather than leaving hidden reserved money',async t=>{
  const f=await fixture(t);const original=f.store.run.bind(f.store);
  f.store.run=async(sql,...args)=>{
    if(sql.startsWith('INSERT INTO confirmations')&&JSON.parse(args[3]).type==='membership_import_v1')throw new Error('synthetic-ticket-write-failure');
    return original(sql,...args);
  };
  await assert.rejects(f.members.startImport('u',job(100),source,10),/synthetic-ticket-write-failure/);
  f.store.run=original;
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,20);
  assert.equal((await f.members.startImport('u',job(100),source,10)).pointsReserved,10);
});
test('a consumed-receipt write failure rolls back capture and a later retry charges exactly once',async t=>{
  const f=await fixture(t);await f.members.startImport('u',job(100),source,10);const original=f.store.run.bind(f.store);
  f.store.run=async(sql,...args)=>{
    if(sql.startsWith('UPDATE confirmations SET result=')){const row=JSON.parse(args[0]);if(row.type==='membership_import_v1'&&row.state==='consumed')throw new Error('synthetic-finish-write-failure');}
    return original(sql,...args);
  };
  await assert.rejects(f.members.finishImport('u',job(100),true),/synthetic-finish-write-failure/);f.store.run=original;
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,10);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入题库'")).n,0);
  await f.members.finishImport('u',job(100),true);await f.members.finishImport('u',job(100),true);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入题库'")).n,1);
});
test('cancel-before-start binds a zero-cost released tombstone and blocks late quota or points reservations',async t=>{
  const f=await fixture(t);const beforeQuota=(await f.members.snapshot('u')).aiImports,beforeWallet=await f.wallet.snapshot('u');
  const stopped=await f.members.finishImport('u',job(100),false,source);
  assert.equal(stopped.state,'released');assert.equal(stopped.funding,'quota');assert.equal(stopped.questionLimit,3000);
  for(const key of ['pointsCost','pointsReserved','pointsCharged'])assert.equal(stopped[key],0);
  assert.deepEqual(await f.members.startImport('u',job(100),source,10),stopped);
  assert.deepEqual(await f.members.startImport('u',job(100),source),stopped);
  assert.deepEqual(await f.members.finishImport('u',job(100),false,source),stopped);
  assert.deepEqual((await f.members.snapshot('u')).aiImports,beforeQuota);assert.deepEqual(await f.wallet.snapshot('u'),beforeWallet);
  await assert.rejects(f.members.finishImport('u',job(100),true,source),e=>e.code==='AI_IMPORT_JOB_RELEASED');
});
test('cancel-after-an-unacknowledged-start releases the original point hold once',async t=>{
  const f=await fixture(t);await f.members.startImport('u',job(100),source,10);
  const stopped=await f.members.finishImport('u',job(100),false,source);assert.equal(stopped.funding,'points');assert.equal(stopped.state,'released');assert.equal(stopped.pointsCharged,0);
  assert.equal((await f.wallet.snapshot('u')).pointsAvailable,20);assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);
  assert.deepEqual(await f.members.finishImport('u',job(100),false,source),stopped);
  assert.deepEqual(await f.members.startImport('u',job(100),source,10),stopped);
});
test('a mismatched cancellation hash cannot release another file reservation or replace a tombstone',async t=>{
  const f=await fixture(t);await f.members.startImport('u',job(100),source,10);
  const before=await f.wallet.snapshot('u');
  await assert.rejects(f.members.finishImport('u',job(100),false,'b'.repeat(64)),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
  assert.deepEqual(await f.wallet.snapshot('u'),before);assert.equal((await f.members.requireImport('u',job(100),source)).state,'reserved');
  await f.members.finishImport('u',job(101),false,source);
  await assert.rejects(f.members.startImport('u',job(101),'b'.repeat(64),10),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
  await assert.rejects(f.members.finishImport('u',job(101),false,'b'.repeat(64)),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
});
test('concurrent cancellation and start never leave a reserved hold after cancellation commits',async t=>{
  const f=await fixture(t);
  for(const cancelFirst of [true,false]){
    const id=job(cancelFirst?100:101),start=()=>f.members.startImport('u',id,source,10),stop=()=>f.members.finishImport('u',id,false,source);
    await Promise.all(cancelFirst?[stop(),start()]:[start(),stop()]);
    const result=await f.members.startImport('u',id,source,10);assert.equal(result.state,'released');assert.equal(result.pointsCharged,0);
  }
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,20);
});
test('legacy finish without source hash keeps 404 and malformed tombstone requests remain rejected',async t=>{
  const f=await fixture(t);
  await assert.rejects(f.members.finishImport('u',job(100),false),e=>e.code==='AI_IMPORT_JOB_NOT_FOUND'&&e.statusCode===404);
  await assert.rejects(f.members.finishImport('u',job(100),true,source),e=>e.code==='AI_IMPORT_JOB_NOT_FOUND');
  await assert.rejects(f.members.finishImport('u','bad-job',false,source),e=>e.code==='AI_IMPORT_JOB_INVALID');
  await assert.rejects(f.members.finishImport('u',job(100),false,'not-a-hash'),e=>e.code==='AI_IMPORT_JOB_INVALID');
  await assert.rejects(f.members.requireImport('u',job(100),source),e=>e.code==='AI_IMPORT_TICKET_REQUIRED');
});
test('HTTP cancellation hash is optional for legacy requests and closes the lost-start race',async t=>{
  const app=await testApp();t.after(()=>app.close());const user=await register(app,'cancel-http');const endpoint='/v1/memberships/ai-imports/'+job(100);
  assert.equal((await call(app,'POST',endpoint+'/finish',user.accessToken,{success:false})).statusCode,404);
  const stopped=await call(app,'POST',endpoint+'/finish',user.accessToken,{success:false,sourceHash:source});assert.equal(stopped.statusCode,200,stopped.body);
  assert.equal(stopped.json().state,'released');assert.equal(stopped.json().pointsAvailable,10);assert.equal(stopped.json().aiImports.available,0);
  const late=await call(app,'POST',endpoint+'/start',user.accessToken,{sourceHash:source,acceptedPointsCost:10});assert.equal(late.json().state,'released');
  assert.equal(late.json().aiImports.available,0);assert.equal(late.json().pointsAvailable,10);
  const mismatch=await call(app,'POST',endpoint+'/finish',user.accessToken,{success:false,sourceHash:'b'.repeat(64)});assert.equal(mismatch.statusCode,409);
});
