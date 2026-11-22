import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {membershipAccount,membershipPlan,MEMBERSHIP_PLANS} from '../src/membership.js';
import {legacyMembershipAccount} from './membership-legacy-fixture.js';
import {pointWallet} from '../src/point-wallet.js';

const initial=Date.parse('2026-11-22T12:00:00Z'),source='a'.repeat(64);
const job=n=>n.toString(16).padStart(8,'0')+'-1111-4111-8111-111111111111';
async function fixture(t){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());let now=initial;
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES('u','lifetime-fixture','fixture','not-a-password','user',0,10)");
  const options={clock:()=>now};
  return {store,m:membershipAccount(store,options),w:pointWallet(store,options),
    legacy:legacyMembershipAccount(store,options),time:value=>{now=value;}};
}
test('permanent catalogue preserves prices and advertises lifetime validity and updates',()=>{
  assert.deepEqual(MEMBERSHIP_PLANS.map(p=>[p.plan,p.amountMinor,p.points,p.aiImports]),[['go',1600,120,5],['plus',2660,320,15]]);
  assert(MEMBERSHIP_PLANS.every(p=>p.billing==='lifetime'&&p.permanent===true&&p.lifetimeUpdates===true));
});
test('Go remains active for years and refreshes never grant another month of points or imports',async t=>{
  const f=await fixture(t),receipt=await f.m.fulfill('u','go-once','go');
  assert.equal(receipt.endsAt,null);assert.equal(receipt.permanent,true);
  for(const time of [initial,initial+32*86400000,Date.parse('2056-11-22T12:00:00Z')]){
    f.time(time);const s=await f.m.snapshot('u'),w=await f.w.snapshot('u');
    assert.equal(s.plan,'go');assert.equal(s.active,true);assert.equal(s.permanent,true);assert.equal(s.lifetimeUpdates,true);
    assert.equal(s.expiresAt,null);assert.equal(s.subscriptionExpiresAt,null);assert.equal(s.nextPlan,null);
    assert.equal(s.aiImports.granted,7);assert.equal(w.permanentAvailable,130);assert.equal(w.monthlyAvailable,0);
  }
});
test('callback retry after a new service instance retains the same gift and receipt',async t=>{
  const f=await fixture(t),first=await f.m.fulfill('u','plus-once','plus');
  const restarted=membershipAccount(f.store,{clock:()=>initial+86400000});
  assert.deepEqual(await restarted.fulfill('u','plus-once','plus'),first);
  assert.equal((await restarted.snapshot('u')).aiImports.granted,17);
  assert.equal((await f.w.snapshot('u')).permanentAvailable,330);
  assert.equal((await restarted.orderReceipt('u','plus-once')).effectiveEndsAt,null);
  await assert.rejects(restarted.fulfill('u','plus-once','go'),e=>e.code==='MEMBERSHIP_ORDER_CONFLICT');
});
test('Go to Plus permanently upgrades immediately and keeps all previously issued points and imports',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','go','go');f.time(initial+86400000);
  const plus=await f.m.fulfill('u','plus','plus');assert.equal(plus.startsAt,new Date(initial+86400000).toISOString());
  f.time(Date.parse('2056-12-22T12:00:00Z'));
  const active=await f.m.snapshot('u');assert.equal(active.plan,'plus');assert.equal(active.aiImports.granted,22);
  assert.equal(active.miniBoard,true);assert.equal(active.replay,true);assert.equal(active.cloudEngine,false);
  assert.equal((await f.w.snapshot('u')).permanentAvailable,450);
});
test('late payment of an already open lower-tier order never downgrades permanent Plus',async t=>{
  const f=await fixture(t);await f.m.freezeOffer('u','late-go',membershipPlan('go'));
  await f.m.fulfill('u','plus','plus');await f.m.fulfill('u','late-go','go');await f.m.fulfill('u','late-go','go');
  assert.equal((await f.m.snapshot('u')).plan,'plus');assert.equal((await f.m.snapshot('u')).aiImports.granted,22);
  assert.equal((await f.w.snapshot('u')).permanentAvailable,450);
});
test('same or lower tier cannot be offered again, while an upgrade remains available',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','go','go');
  await assert.rejects(f.m.assertPurchasable('u',membershipPlan('go')),e=>e.code==='MEMBERSHIP_ALREADY_OWNED');
  await f.m.assertPurchasable('u',membershipPlan('plus'));
  await f.m.fulfill('u','plus','plus');
  for(const plan of MEMBERSHIP_PLANS)await assert.rejects(f.m.assertPurchasable('u',plan),e=>e.code==='MEMBERSHIP_ALREADY_OWNED');
});
test('permanent Go can exchange five points after its one-time import quota is exhausted years later',async t=>{
  const f=await fixture(t);await f.m.fulfill('u','go','go');f.time(Date.parse('2056-11-22T12:00:00Z'));
  for(let n=1;n<=7;n++){await f.m.startImport('u',job(n),source);await f.m.finishImport('u',job(n),true);}
  const ticket=await f.m.startImport('u',job(100),source,true);assert.equal(ticket.funding,'points');
  await f.m.finishImport('u',job(100),true);await f.m.finishImport('u',job(100),true);
  assert.equal((await f.m.snapshot('u')).aiImports.granted,7);assert.equal((await f.w.snapshot('u')).permanentAvailable,125);
});
test('frozen retired monthly offers retain their original period and are not silently converted',async t=>{
  const f=await fixture(t),receipt=await f.legacy.fulfill('u','legacy-go','go');
  assert.equal(receipt.benefits.billing,'monthly');assert.notEqual(receipt.endsAt,null);
  f.time(Date.parse(receipt.endsAt)+1);
  assert.equal((await f.m.snapshot('u')).plan,'free');assert.equal((await f.w.snapshot('u')).permanentAvailable,10);
  assert.equal((await f.m.orderReceipt('u','legacy-go')).endsAt,receipt.endsAt);
});
