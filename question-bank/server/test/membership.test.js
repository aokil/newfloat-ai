import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {nextMembershipMonth,membershipPlan} from '../src/membership.js';
import {pointWallet} from '../src/point-wallet.js';
import {legacyMembershipAccount} from './membership-legacy-fixture.js';
const JAN31=Date.parse('2026-01-31T12:30:00+08:00'),job='11111111-1111-4111-8111-111111111111',source='a'.repeat(64);
async function fixture(t){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());let now=JAN31;
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,membership,points_balance) VALUES('u','u','Synthetic','x','user',0,'sponsor',100)");
  return {store,m:legacyMembershipAccount(store,{clock:()=>now}),w:pointWallet(store,{clock:()=>now}),setTime:n=>now=n};
}
test('new and existing sponsor accounts receive two cumulative imports once, without a paid upgrade',async t=>{
  const f=await fixture(t);for(let i=0;i<3;i++){const s=await f.m.snapshot('u');assert.equal(s.plan,'free');assert.equal(s.importLimit,3000);assert.equal(s.libraryCapacity,10000);assert.equal(s.aiImports.available,2);assert.equal(s.historyLimit,500);}
  assert.equal((await f.w.snapshot('u')).permanentAvailable,100);
});
test('calendar billing restores the original day after February and preserves time of day',()=>{
  const feb=nextMembershipMonth(JAN31,31),march=nextMembershipMonth(feb,31);
  assert.equal(new Date(feb).toISOString(),'2026-02-28T04:30:00.000Z');assert.equal(new Date(march).toISOString(),'2026-03-31T04:30:00.000Z');
});
test('Go fulfillment is idempotent, grants monthly points separately and includes cumulative imports',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','order-go','go');await f.m.fulfill('u','order-go','go');
  const s=await f.m.snapshot('u');assert.equal(s.plan,'go');assert.equal(s.importLimit,5000);assert.equal(s.libraryCapacity,20000);assert.equal(s.aiImports.available,7);assert.equal(s.masterEngine,true);assert.equal(s.miniBoard,false);
  const w=await f.w.snapshot('u');assert.equal(w.monthlyAvailable,120);assert.equal(w.permanentAvailable,100);
  assert.equal((await f.store.all("SELECT * FROM points_ledger WHERE reason LIKE '%月赠点'")).length,1);
});
test('renewal queues a month and does not immediately issue a second gift or import grant',async t=>{
  const f=await fixture(t);const first=await f.m.fulfill('u','first','go'),second=await f.m.fulfill('u','second','go');
  assert.equal(second.startsAt,first.endsAt);assert.equal((await f.m.snapshot('u')).aiImports.available,7);
  f.setTime(Date.parse(first.endsAt));const s=await f.m.snapshot('u');assert.equal(s.aiImports.available,12);assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
});
test('elapsed paid cycles keep unused imports but never revive expired monthly points',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','first','go');await f.m.fulfill('u','second','plus');
  f.setTime(Date.parse('2026-04-10T00:00:00Z'));const s=await f.m.snapshot('u');assert.equal(s.plan,'free');assert.equal(s.aiImports.available,22);
  assert.equal((await f.w.snapshot('u')).pointsAvailable,100);assert.equal((await f.m.snapshot('u')).aiImports.available,22);
});
test('Plus inherits Go local features, uses total 320/15 and keeps cloud unavailable',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','plus','plus');const s=await f.m.snapshot('u');
  assert.equal(s.aiImports.available,17);assert.equal(s.importLimit,10000);assert.equal(s.libraryCapacity,30000);assert.equal(s.historyLimit,3000);
  assert(s.masterEngine&&s.moveArrows&&s.miniBoard&&s.replay);assert.equal(s.cloudEngine,false);assert.equal(s.cloudEngineStatus,'not_connected');
});
test('a whole AI import reserves and consumes one count, retries and groups consume no extra points',async t=>{
  const f=await fixture(t);const a=await f.m.startImport('u',job,source),b=await f.m.startImport('u',job,source);assert.deepEqual(a,b);
  await f.m.requireImport('u',job,source);await f.m.finishImport('u',job,true);await f.m.finishImport('u',job,true);
  const s=await f.m.snapshot('u');assert.equal(s.aiImports.used,1);assert.equal(s.aiImports.available,1);assert.equal((await f.w.snapshot('u')).pointsBalance,100);
  await assert.rejects(f.m.startImport('u',job,'b'.repeat(64)),e=>e.code==='AI_IMPORT_JOB_CONFLICT');
});
test('failed imports release once and a released task cannot call paid repair',async t=>{
  const f=await fixture(t);await f.m.startImport('u',job,source);await f.m.finishImport('u',job,false);await f.m.finishImport('u',job,false);
  assert.equal((await f.m.snapshot('u')).aiImports.available,2);await assert.rejects(f.m.requireImport('u',job,source),e=>e.code==='AI_IMPORT_TICKET_INVALID');
});
test('concurrent imports cannot overspend the final two counts',async t=>{
  const f=await fixture(t);const results=await Promise.allSettled([1,2,3].map(n=>f.m.startImport('u',job.replace(/^1/,String(n)),source)));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,2);assert.equal((await f.m.snapshot('u')).aiImports.available,0);
});
test('an authorized task preserves its creation limit after membership expiry',async t=>{
  const f=await fixture(t);const period=await f.m.fulfill('u','plus','plus');const ticket=await f.m.startImport('u',job,source);assert.equal(ticket.questionLimit,10000);
  f.setTime(Date.parse(period.endsAt)+1);assert.equal((await f.m.snapshot('u')).importLimit,3000);assert.equal((await f.m.snapshot('u')).libraryCapacity,10000);assert.equal((await f.m.requireImport('u',job,source)).questionLimit,10000);
  await f.m.finishImport('u',job,true);assert.equal((await f.m.snapshot('u')).aiImports.used,1);
});
test('Go to Plus upgrades immediately and resumes the exact remaining Go duration without double grants',async t=>{
  const f=await fixture(t);const go=await f.m.fulfill('u','go','go'),originalEnd=Date.parse(go.endsAt);
  const upgradeAt=originalEnd-10*86400000;f.setTime(upgradeAt);
  const plus=await f.m.fulfill('u','plus','plus');assert.equal(Date.parse(plus.startsAt),upgradeAt);
  const active=await f.m.snapshot('u');assert.equal(active.plan,'plus');assert.equal(active.aiImports.granted,22);assert.equal(active.nextPlan,'go');
  assert.equal(Date.parse(active.subscriptionExpiresAt),Date.parse(plus.endsAt)+10*86400000);
  assert.equal((await f.w.snapshot('u')).monthlyAvailable,440);
  f.setTime(originalEnd+1);assert.equal((await f.w.snapshot('u')).monthlyAvailable,440);
  f.setTime(Date.parse(plus.endsAt));assert.equal((await f.m.snapshot('u')).plan,'go');assert.equal((await f.m.snapshot('u')).aiImports.granted,22);assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
  await f.m.fulfill('u','plus','plus');assert.equal((await f.m.snapshot('u')).aiImports.granted,22);
});
test('buying Go during Plus queues it; renewing Plus stays contiguous and shifts the pending Go',async t=>{
  const f=await fixture(t);const plus=await f.m.fulfill('u','p1','plus'),go=await f.m.fulfill('u','g1','go');assert.equal(go.startsAt,plus.endsAt);
  const renew=await f.m.fulfill('u','p2','plus');assert.equal(renew.startsAt,plus.endsAt);assert.equal((await f.m.snapshot('u')).plan,'plus');
  f.setTime(Date.parse(renew.startsAt));assert.equal((await f.m.snapshot('u')).plan,'plus');
  f.setTime(Date.parse(renew.endsAt));assert.equal((await f.m.snapshot('u')).plan,'go');assert.equal((await f.m.snapshot('u')).aiImports.granted,37);
});
test('account capacity and restored per-file limit project without rewriting purchased benefits',async t=>{
  const f=await fixture(t),legacy={...membershipPlan('go'),importLimit:20000};delete legacy.libraryCapacity;
  await f.m.freezeOffer('u','legacy-go',legacy);await f.m.fulfill('u','legacy-go','go');
  assert.equal((await f.m.orderReceipt('u','legacy-go')).benefits.importLimit,20000);
  assert.equal((await f.m.orderReceipt('u','legacy-go')).benefits.libraryCapacity,undefined);
  const current=await f.m.snapshot('u');assert.equal(current.importLimit,5000);assert.equal(current.libraryCapacity,20000);assert.equal(current.points,120);assert.equal(current.aiImports.available,7);assert.equal(current.historyLimit,1500);
  assert.equal((await f.m.startImport('u',job,source)).questionLimit,5000);
});
test('old already-reserved import tickets remain frozen after the new policy',async t=>{
  const f=await fixture(t);await f.m.startImport('u',job,source);
  const stored=(await f.store.all('SELECT * FROM confirmations')).find(row=>JSON.parse(row.result).type==='membership_import_v1');
  const legacy=JSON.parse(stored.result);legacy.questionLimit=20000;
  await f.store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(legacy),'u',stored.idempotency_key);
  assert.equal((await f.m.startImport('u',job,source)).questionLimit,20000);
  assert.equal((await f.m.snapshot('u')).importLimit,3000);
  assert.equal((await f.m.snapshot('u')).libraryCapacity,10000);
  assert.equal((await f.m.snapshot('u')).aiImports.reserved,1);
});
test('free arrows are independent of subscription while automatic moves require Go or Plus',async t=>{
  const f=await fixture(t);const base=await f.m.snapshot('u');
  assert.equal(base.moveArrows,true);assert.equal(base.automaticMoves,false);assert.equal(base.masterEngine,false);
  assert.equal(base.libraryCapacity,10000);assert.equal(base.importLimit,3000);assert.equal(base.historyLimit,500);assert.equal(base.aiImports.available,2);
  for(const tier of ['go','plus']){
    await f.m.fulfill('u','automatic-'+tier,tier);const active=await f.m.snapshot('u');
    assert.equal(active.plan,tier);assert.equal(active.moveArrows,true);assert.equal(active.automaticMoves,true);
    assert.equal(membershipPlan(tier).automaticMoves,true);assert.equal(membershipPlan(tier).moveArrows,true);
  }
});
test('new movement rights project onto legacy periods without mutating paid order or gift snapshots',async t=>{
  const f=await fixture(t),old={...membershipPlan('go'),moveArrows:false};delete old.automaticMoves;
  await f.m.freezeOffer('u','legacy-movement',old);await f.m.fulfill('u','legacy-movement','go');
  const receipt=await f.m.orderReceipt('u','legacy-movement');
  assert.equal(receipt.benefits.moveArrows,false);assert.equal(receipt.benefits.automaticMoves,undefined);
  const active=await f.m.snapshot('u');assert.equal(active.moveArrows,true);assert.equal(active.automaticMoves,true);
  assert.equal(active.points,120);assert.equal(active.aiImports.available,7);assert.equal(active.historyLimit,1500);
  assert.equal(active.libraryCapacity,20000);assert.equal(active.importLimit,5000);
  assert.deepEqual((await f.m.orderReceipt('u','legacy-movement')).benefits,receipt.benefits);
});
test('expired subscriptions keep free arrows but cannot retain automatic movement',async t=>{
  const f=await fixture(t);const period=await f.m.fulfill('u','expire-movement','plus');
  f.setTime(Date.parse(period.endsAt)+1);const expired=await f.m.snapshot('u');
  assert.equal(expired.plan,'free');assert.equal(expired.moveArrows,true);assert.equal(expired.automaticMoves,false);
  assert.equal(expired.aiImports.available,17);assert.equal(expired.historyLimit,500);assert.equal(expired.libraryCapacity,10000);
});
