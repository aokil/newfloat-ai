import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {nextMembershipMonth,membershipPlan} from '../src/membership.js';
import {pointWallet} from '../src/point-wallet.js';
import {legacyMembershipAccount} from './membership-legacy-fixture.js';
const JAN31=Date.parse('2026-01-31T12:30:00+08:00');
async function fixture(t){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());let now=JAN31;
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,membership,points_balance) VALUES('u','u','Synthetic','x','user',0,'sponsor',100)");
  return {store,m:legacyMembershipAccount(store,{clock:()=>now}),w:pointWallet(store,{clock:()=>now}),setTime:n=>now=n};
}
test('legacy sponsor records share the original point-account limits',async t=>{
  const f=await fixture(t);for(let i=0;i<3;i++){const s=await f.m.snapshot('u');assert.equal(s.plan,'free');assert.equal(s.importLimit,3000);assert.equal(s.libraryCapacity,10000);assert.equal(s.aiImports.available,0);assert.equal(s.historyLimit,500);}
  assert.equal((await f.w.snapshot('u')).permanentAvailable,100);
});
test('calendar billing restores the original day after February and preserves time of day',()=>{
  const feb=nextMembershipMonth(JAN31,31),march=nextMembershipMonth(feb,31);
  assert.equal(new Date(feb).toISOString(),'2026-02-28T04:30:00.000Z');assert.equal(new Date(march).toISOString(),'2026-03-31T04:30:00.000Z');
});
test('legacy Go fulfillment grants its frozen monthly points idempotently',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','order-go','go');await f.m.fulfill('u','order-go','go');
  assert.equal((await f.m.snapshot('u')).active,false);
  const w=await f.w.snapshot('u');assert.equal(w.monthlyAvailable,120);assert.equal(w.permanentAvailable,100);
  assert.equal((await f.store.all("SELECT * FROM points_ledger WHERE reason LIKE '%月赠点'")).length,1);
});
test('legacy renewal waits until its frozen start date',async t=>{
  const f=await fixture(t);const first=await f.m.fulfill('u','first','go'),second=await f.m.fulfill('u','second','go');
  assert.equal(second.startsAt,first.endsAt);assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
  f.setTime(Date.parse(first.endsAt));const s=await f.m.snapshot('u');assert.equal(s.aiImports.available,0);assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
});
test('elapsed legacy cycles never revive expired monthly points',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','first','go');await f.m.fulfill('u','second','plus');
  f.setTime(Date.parse('2026-04-10T00:00:00Z'));const s=await f.m.snapshot('u');assert.equal(s.plan,'free');assert.equal(s.aiImports.available,0);
  assert.equal((await f.w.snapshot('u')).pointsAvailable,100);assert.equal((await f.m.snapshot('u')).aiImports.available,0);
});
test('Go to Plus upgrades immediately and resumes the exact remaining Go duration without double grants',async t=>{
  const f=await fixture(t);const go=await f.m.fulfill('u','go','go'),originalEnd=Date.parse(go.endsAt);
  const upgradeAt=originalEnd-10*86400000;f.setTime(upgradeAt);
  const plus=await f.m.fulfill('u','plus','plus');assert.equal(Date.parse(plus.startsAt),upgradeAt);
  assert.equal((await f.m.orderReceipt('u','go')).effectiveEndsAt,new Date(Date.parse(plus.endsAt)+10*86400000).toISOString());
  assert.equal((await f.w.snapshot('u')).monthlyAvailable,440);
  f.setTime(originalEnd+1);assert.equal((await f.w.snapshot('u')).monthlyAvailable,440);
  f.setTime(Date.parse(plus.endsAt));await f.m.snapshot('u');assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
  await f.m.fulfill('u','plus','plus');assert.equal((await f.w.snapshot('u')).monthlyAvailable,120);
});
test('buying Go during Plus queues it; renewing Plus stays contiguous and shifts the pending Go',async t=>{
  const f=await fixture(t);const plus=await f.m.fulfill('u','p1','plus'),go=await f.m.fulfill('u','g1','go');assert.equal(go.startsAt,plus.endsAt);
  const renew=await f.m.fulfill('u','p2','plus');assert.equal(renew.startsAt,plus.endsAt);assert.equal((await f.m.orderReceipt('u','g1')).activation,'scheduled');
  f.setTime(Date.parse(renew.startsAt));assert.equal((await f.m.orderReceipt('u','g1')).activation,'scheduled');
  f.setTime(Date.parse(renew.endsAt));assert.equal((await f.m.orderReceipt('u','g1')).activation,'active');
});
test('account capacity and restored per-file limit project without rewriting purchased benefits',async t=>{
  const f=await fixture(t),legacy={...membershipPlan('go'),importLimit:20000};delete legacy.libraryCapacity;
  await f.m.freezeOffer('u','legacy-go',legacy);await f.m.fulfill('u','legacy-go','go');
  assert.equal((await f.m.orderReceipt('u','legacy-go')).benefits.importLimit,20000);
  assert.equal((await f.m.orderReceipt('u','legacy-go')).benefits.libraryCapacity,undefined);
  const current=await f.m.snapshot('u');assert.equal(current.importLimit,3000);assert.equal(current.libraryCapacity,10000);assert.equal(current.aiImports.available,0);assert.equal(current.historyLimit,500);
});
