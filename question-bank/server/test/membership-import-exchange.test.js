import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {membershipAccount,membershipPlan} from '../src/membership.js';
import {pointWallet} from '../src/point-wallet.js';
import {testApp,register,call} from './helpers.js';

const source='a'.repeat(64),job=n=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
async function fixture(t,plan='go'){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());let now=Date.parse('2026-01-31T04:30:00Z');
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES('u','exchange-fixture','fixture','not-a-password','user',0,20)");
  const options={clock:()=>now},members=membershipAccount(store,options),wallet=pointWallet(store,options);
  const period=plan==='free'?null:await members.fulfill('u','synthetic-'+plan,plan);
  return {store,members,wallet,period,options,time:value=>{now=value;}};
}
async function exhaust(members,owner='u'){
  const count=(await members.snapshot(owner)).aiImports.available;
  for(let i=0;i<count;i++){await members.startImport(owner,job(i+1),source);await members.finishImport(owner,job(i+1),true);}
  return count;
}
async function leave(wallet,points){
  const available=(await wallet.snapshot('u')).pointsAvailable,amount=Math.round((available-points)*100);
  if(amount>0){await wallet.reserve('u','synthetic-spend',amount);await wallet.capture('u','synthetic-spend',amount);}
}
test('existing import quota always wins over an enabled points-exchange flag',async t=>{
  const f=await fixture(t);const before=await f.wallet.snapshot('u');
  const ticket=await f.members.startImport('u',job(100),source,true);assert.equal(ticket.funding,'quota');assert.equal(ticket.pointsCost,0);assert.equal(ticket.pointsReserved,0);
  assert.deepEqual(await f.wallet.snapshot('u'),before);await f.members.finishImport('u',job(100),true);
  assert.equal((await f.members.snapshot('u')).aiImports.used,1);assert.deepEqual(await f.wallet.snapshot('u'),before);
});
test('exhausted Go imports reserve and capture exactly five points without fabricating gift counts',async t=>{
  const f=await fixture(t);await exhaust(f.members);const before=(await f.members.snapshot('u')).aiImports;
  const ticket=await f.members.startImport('u',job(100),source,true);
  assert.equal(ticket.funding,'points');assert.equal(ticket.pointsCost,5);assert.equal(ticket.pointsReserved,5);assert.equal(ticket.pointsCharged,0);
  assert.equal((await f.wallet.snapshot('u')).pointsAvailable,135);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入 · 点数兑换次数'")).n,0);
  const done=await f.members.finishImport('u',job(100),true);assert.equal(done.state,'consumed');assert.equal(done.pointsCharged,5);assert.equal(done.pointsReserved,0);
  assert.deepEqual((await f.members.snapshot('u')).aiImports,before);
  const balance=await f.wallet.snapshot('u');assert.equal(balance.monthlyAvailable,115);assert.equal(balance.permanentAvailable,20);
});
test('Plus inherits the five-point fallback and quotas keep their own monthly grant',async t=>{
  const f=await fixture(t,'plus');assert.equal(await exhaust(f.members),17);
  assert.equal((await f.members.startImport('u',job(100),source,true)).funding,'points');await f.members.finishImport('u',job(100),true);
  assert.equal((await f.members.snapshot('u')).aiImports.granted,17);assert.equal((await f.wallet.snapshot('u')).monthlyAvailable,315);
});
test('free accounts cannot exchange points even with balance and explicit consent',async t=>{
  const f=await fixture(t,'free');await exhaust(f.members);
  await assert.rejects(f.members.startImport('u',job(100),source,true),e=>e.code==='AI_IMPORT_EXCHANGE_UNAVAILABLE');
  assert.equal((await f.wallet.snapshot('u')).pointsBalance,20);assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);
});
test('disabled toggle and missing legacy flag never silently reserve or charge points',async t=>{
  const f=await fixture(t);await exhaust(f.members);
  await assert.rejects(f.members.startImport('u',job(100),source,false),e=>e.code==='AI_IMPORT_QUOTA_REQUIRED');
  await assert.rejects(f.members.startImport('u',job(101),source),e=>e.code==='AI_IMPORT_QUOTA_REQUIRED');
  await assert.rejects(f.members.startImport('u',job(102),source,'true'),e=>e.code==='INVALID_REQUEST');
  assert.equal((await f.wallet.snapshot('u')).pointsBalance,140);assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);
});
test('less than five available points fails atomically without a ticket or phantom count',async t=>{
  const f=await fixture(t);await exhaust(f.members);await leave(f.wallet,4.99);
  await assert.rejects(f.members.startImport('u',job(100),source,true),e=>e.code==='AI_IMPORT_EXCHANGE_POINTS_REQUIRED');
  assert.equal((await f.wallet.snapshot('u')).pointsAvailable,4.99);assert.equal((await f.members.snapshot('u')).aiImports.available,0);
  await assert.rejects(f.members.requireImport('u',job(100),source),e=>e.code==='AI_IMPORT_TICKET_REQUIRED');
});
test('failure or removal releases the same point hold once and cannot later consume the released job',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);
  const released=await f.members.finishImport('u',job(100),false);assert.equal(released.state,'released');assert.equal(released.pointsCharged,0);
  assert.deepEqual(await f.members.finishImport('u',job(100),false),released);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,140);
  await assert.rejects(f.members.finishImport('u',job(100),true),e=>e.code==='AI_IMPORT_JOB_RELEASED');
});
test('restarts and repeated start/finish recover original funding without charging twice',async t=>{
  const f=await fixture(t);await exhaust(f.members);const first=await f.members.startImport('u',job(100),source,true);
  const restored=membershipAccount(f.store,f.options);assert.deepEqual(await restored.startImport('u',job(100),source,false),first);
  const done=await restored.finishImport('u',job(100),true);assert.deepEqual(await restored.finishImport('u',job(100),true),done);
  assert.deepEqual(await restored.finishImport('u',job(100),false),done); // Removing a consumed result is not a refund.
  assert.deepEqual(await restored.startImport('u',job(100),source),done);
  assert.equal((await f.wallet.snapshot('u')).pointsBalance,135);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入 · 点数兑换次数'")).n,1);
  await assert.rejects(restored.startImport('u',job(100),'b'.repeat(64),true),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
});
test('competing exhausted jobs cannot both reserve the last five points',async t=>{
  const f=await fixture(t);await exhaust(f.members);await leave(f.wallet,5);
  const outcomes=await Promise.allSettled([100,101].map(n=>f.members.startImport('u',job(n),source,true)));
  assert.equal(outcomes.filter(r=>r.status==='fulfilled').length,1);assert.equal(outcomes.filter(r=>r.status==='rejected')[0].reason.code,'AI_IMPORT_EXCHANGE_POINTS_REQUIRED');
  const ticket=outcomes.find(r=>r.status==='fulfilled').value;assert.equal((await f.wallet.snapshot('u')).pointsAvailable,0);
  await f.members.finishImport('u',ticket.jobId,true);assert.equal((await f.wallet.snapshot('u')).pointsBalance,0);
});
test('a quota already reserved by another job is not reused and point funding never switches later',async t=>{
  const f=await fixture(t);for(let n=1;n<=6;n++){await f.members.startImport('u',job(n),source);await f.members.finishImport('u',job(n),true);}
  await f.members.startImport('u',job(7),source);assert.equal((await f.members.snapshot('u')).aiImports.available,0);
  const paid=await f.members.startImport('u',job(100),source,true);assert.equal(paid.funding,'points');
  await f.members.finishImport('u',job(7),false);assert.equal((await f.members.snapshot('u')).aiImports.available,1);
  assert.equal((await f.members.startImport('u',job(100),source,false)).funding,'points');await f.members.finishImport('u',job(100),true);
  assert.equal((await f.members.snapshot('u')).aiImports.available,1);
});
test('cross-month capture uses the originally held subscription points after subscription expiry',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);
  f.time(Date.parse(f.period.endsAt)+1);assert.equal((await f.members.quota('u')).subscriptionActive,false);
  const done=await f.members.finishImport('u',job(100),true);assert.equal(done.pointsCharged,5);
  const balance=await f.wallet.snapshot('u');assert.equal(balance.permanentAvailable,20);assert.equal(balance.monthlyAvailable,0);assert.equal(balance.pointsReserved,0);
  await assert.rejects(f.members.startImport('u',job(101),source,true),e=>e.code==='AI_IMPORT_EXCHANGE_UNAVAILABLE');
});
test('release after expiry does not convert expired subscription points into permanent balance',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);
  f.time(Date.parse(f.period.endsAt)+1);await f.members.finishImport('u',job(100),false);
  assert.equal((await f.wallet.snapshot('u')).pointsBalance,20);assert.equal((await f.wallet.snapshot('u')).permanentAvailable,20);
});
test('old quota receipts without a funding field remain quota-backed and preserve their reservation',async t=>{
  const f=await fixture(t);await f.members.startImport('u',job(100),source);
  const row=(await f.store.all('SELECT * FROM confirmations')).find(r=>{try{const v=JSON.parse(r.result);return v.type==='membership_import_v1'&&v.jobId===job(100);}catch{return false;}});
  const old=JSON.parse(row.result);delete old.funding;delete old.pointsCost;delete old.allowPointsExchange;
  await f.store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(old),'u',row.idempotency_key);
  const recovered=await f.members.startImport('u',job(100),source,true);assert.equal(recovered.funding,'quota');assert.equal(recovered.pointsCost,0);
  await f.members.finishImport('u',job(100),true);assert.equal((await f.members.snapshot('u')).aiImports.used,1);assert.equal((await f.wallet.snapshot('u')).pointsBalance,140);
});
test('exchange policy projects onto legacy paid periods without changing their purchased receipts',async t=>{
  const f=await fixture(t,'free'),legacy={...membershipPlan('go')};delete legacy.allowPointsExchange;delete legacy.pointsPerImportExchange;
  await f.members.freezeOffer('u','legacy-offer',legacy);await f.members.fulfill('u','legacy-offer','go');
  const original=(await f.members.orderReceipt('u','legacy-offer')).benefits;
  const policy=await f.members.quota('u');assert.deepEqual(policy.exchangePolicy,{allowed:true,pointsPerImport:5,defaultEnabled:true});
  assert.deepEqual((await f.members.orderReceipt('u','legacy-offer')).benefits,original);assert.equal(original.allowPointsExchange,undefined);
});
test('HTTP quota is authenticated and lease-free; explicit consent and actual wallet settlement are returned',async t=>{
  const app=await testApp();t.after(()=>app.close());const user=await register(app,'exchange-http'),owner=user.principal.userId,members=membershipAccount(app.store);
  assert.equal((await call(app,'GET','/v1/memberships/ai-imports/quota')).statusCode,401);
  const before=(await call(app,'GET','/v1/memberships/ai-imports/quota',user.accessToken)).json();assert.equal(before.exchangePolicy.allowed,false);assert.equal(before.exchangePolicy.defaultEnabled,true);
  assert.equal(before.validUntil,undefined);assert.equal(before.entitlements,undefined);assert.equal(before.pointsAvailable,10);
  await members.fulfill(owner,'http-go','go');await exhaust(members,owner);
  const endpoint='/v1/memberships/ai-imports/'+job(100);
  assert.equal((await call(app,'POST',endpoint+'/start',user.accessToken,{sourceHash:source})).statusCode,403);
  assert.equal((await call(app,'POST',endpoint+'/start',user.accessToken,{sourceHash:source,allowPointsExchange:true,pointsCost:0})).statusCode,400);
  const response=await call(app,'POST',endpoint+'/start',user.accessToken,{sourceHash:source,allowPointsExchange:true});assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().funding,'points');assert.equal(response.json().pointsAvailable,125);assert.equal(response.json().aiImports.available,0);
  const done=await call(app,'POST',endpoint+'/finish',user.accessToken,{success:true});assert.equal(done.json().pointsCharged,5);assert.equal(done.json().pointsAvailable,125);
  const quota=(await call(app,'GET','/v1/memberships/ai-imports/quota',user.accessToken)).json();assert.equal(quota.plan,'go');assert.equal(quota.subscriptionActive,true);assert.equal(quota.exchangePolicy.allowed,true);
});
test('a ticket persistence failure rolls back the wallet hold rather than leaving hidden reserved money',async t=>{
  const f=await fixture(t);await exhaust(f.members);const original=f.store.run.bind(f.store);
  f.store.run=async(sql,...args)=>{
    if(sql.startsWith('INSERT INTO confirmations')&&JSON.parse(args[3]).type==='membership_import_v1')throw new Error('synthetic-ticket-write-failure');
    return original(sql,...args);
  };
  await assert.rejects(f.members.startImport('u',job(100),source,true),/synthetic-ticket-write-failure/);
  f.store.run=original;
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,140);
  assert.equal((await f.members.startImport('u',job(100),source,true)).pointsReserved,5);
});
test('a consumed-receipt write failure rolls back capture and a later retry charges exactly once',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);const original=f.store.run.bind(f.store);
  f.store.run=async(sql,...args)=>{
    if(sql.startsWith('UPDATE confirmations SET result=')){const row=JSON.parse(args[0]);if(row.type==='membership_import_v1'&&row.state==='consumed')throw new Error('synthetic-finish-write-failure');}
    return original(sql,...args);
  };
  await assert.rejects(f.members.finishImport('u',job(100),true),/synthetic-finish-write-failure/);f.store.run=original;
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,5);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入 · 点数兑换次数'")).n,0);
  await f.members.finishImport('u',job(100),true);await f.members.finishImport('u',job(100),true);
  assert.equal((await f.store.get("SELECT COUNT(*) n FROM points_ledger WHERE reason='AI导入 · 点数兑换次数'")).n,1);
});
test('cancel-before-start binds a zero-cost released tombstone and blocks late quota or points reservations',async t=>{
  const f=await fixture(t);await exhaust(f.members);const beforeQuota=(await f.members.snapshot('u')).aiImports,beforeWallet=await f.wallet.snapshot('u');
  const stopped=await f.members.finishImport('u',job(100),false,source);
  assert.equal(stopped.state,'released');assert.equal(stopped.funding,'quota');assert.equal(stopped.questionLimit,5000);
  for(const key of ['pointsCost','pointsReserved','pointsCharged'])assert.equal(stopped[key],0);
  assert.deepEqual(await f.members.startImport('u',job(100),source,true),stopped);
  assert.deepEqual(await f.members.startImport('u',job(100),source),stopped);
  assert.deepEqual(await f.members.finishImport('u',job(100),false,source),stopped);
  assert.deepEqual((await f.members.snapshot('u')).aiImports,beforeQuota);assert.deepEqual(await f.wallet.snapshot('u'),beforeWallet);
  await assert.rejects(f.members.finishImport('u',job(100),true,source),e=>e.code==='AI_IMPORT_JOB_RELEASED');
});
test('cancel-after-an-unacknowledged-start releases the original point hold once',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);
  const stopped=await f.members.finishImport('u',job(100),false,source);assert.equal(stopped.funding,'points');assert.equal(stopped.state,'released');assert.equal(stopped.pointsCharged,0);
  assert.equal((await f.wallet.snapshot('u')).pointsAvailable,140);assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);
  assert.deepEqual(await f.members.finishImport('u',job(100),false,source),stopped);
  assert.deepEqual(await f.members.startImport('u',job(100),source,true),stopped);
});
test('a mismatched cancellation hash cannot release another file reservation or replace a tombstone',async t=>{
  const f=await fixture(t);await exhaust(f.members);await f.members.startImport('u',job(100),source,true);
  const before=await f.wallet.snapshot('u');
  await assert.rejects(f.members.finishImport('u',job(100),false,'b'.repeat(64)),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
  assert.deepEqual(await f.wallet.snapshot('u'),before);assert.equal((await f.members.requireImport('u',job(100),source)).state,'reserved');
  await f.members.finishImport('u',job(101),false,source);
  await assert.rejects(f.members.startImport('u',job(101),'b'.repeat(64),true),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
  await assert.rejects(f.members.finishImport('u',job(101),false,'b'.repeat(64)),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
});
test('concurrent cancellation and start never leave a reserved hold after cancellation commits',async t=>{
  const f=await fixture(t);await exhaust(f.members);
  for(const cancelFirst of [true,false]){
    const id=job(cancelFirst?100:101),start=()=>f.members.startImport('u',id,source,true),stop=()=>f.members.finishImport('u',id,false,source);
    await Promise.all(cancelFirst?[stop(),start()]:[start(),stop()]);
    const result=await f.members.startImport('u',id,source,true);assert.equal(result.state,'released');assert.equal(result.pointsCharged,0);
  }
  assert.equal((await f.wallet.snapshot('u')).pointsReserved,0);assert.equal((await f.wallet.snapshot('u')).pointsAvailable,140);
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
  assert.equal(stopped.json().state,'released');assert.equal(stopped.json().pointsAvailable,10);assert.equal(stopped.json().aiImports.available,2);
  const late=await call(app,'POST',endpoint+'/start',user.accessToken,{sourceHash:source,allowPointsExchange:true});assert.equal(late.json().state,'released');
  assert.equal(late.json().aiImports.available,2);assert.equal(late.json().pointsAvailable,10);
  const mismatch=await call(app,'POST',endpoint+'/finish',user.accessToken,{success:false,sourceHash:'b'.repeat(64)});assert.equal(mismatch.statusCode,409);
});
