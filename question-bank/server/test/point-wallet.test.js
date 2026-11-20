import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {pointWallet} from '../src/point-wallet.js';

async function fixture(balance=100){
  const store=new AsyncSqliteStore(':memory:');let now=1000;
  await store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance,points_reserved) VALUES('u','wallet-fixture','fixture','not-a-login-hash','user',0,?,0)",balance);
  return {store,wallet:pointWallet(store,{clock:()=>now}),time:value=>{now=value;}};
}

test('subscription credit is consumed before purchased permanent credit',async t=>{
  const {store,wallet}=await fixture(20);t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'subscription',1000,5000);
  await wallet.reserve('u','gift-first',700);await wallet.capture('u','gift-first',700);
  const state=await wallet.snapshot('u');
  assert.equal(state.monthlyAvailable,3);assert.equal(state.permanentAvailable,20);
});

test('permanent credit is consumed only for the part beyond subscription credit',async t=>{
  const {store,wallet}=await fixture(20);t.after(()=>store.close());
  await wallet.creditMonthly('u',500,'subscription',1000,5000);
  await wallet.reserve('u','mixed',800);await wallet.capture('u','mixed',800);
  const state=await wallet.snapshot('u');
  assert.equal(state.monthlyAvailable,0);assert.equal(state.permanentAvailable,17);
});

test('earliest expiring subscription lot is consumed first regardless of creation order',async t=>{
  const {store,wallet,time}=await fixture(20);t.after(()=>store.close());
  await wallet.creditMonthly('u',800,'later',1000,5000);
  await wallet.creditMonthly('u',200,'earlier',1000,2000);
  await wallet.reserve('u','ordered',300);await wallet.capture('u','ordered',300);
  time(2500);
  const state=await wallet.snapshot('u');
  assert.equal(state.monthlyAvailable,7);assert.equal(state.permanentAvailable,20);
});
test('legacy balance is permanent without granting a second copy',async t=>{
  const {store,wallet}=await fixture();t.after(()=>store.close());
  assert.equal((await wallet.snapshot('u')).permanentAvailable,100);
  assert.equal((await wallet.snapshot('u')).pointsBalance,100);
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM points_ledger')).n,0);
});
test('cross-month capture spends the old held gift and expires its unused remainder',async t=>{
  const {store,wallet,time}=await fixture();t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'cycle-1',1000,2000);
  await wallet.reserve('u','request-1',800,'digest');time(2500);
  let s=await wallet.snapshot('u');assert.equal(s.pointsAvailable,100);assert.equal(s.expiredReserved,8);
  await wallet.capture('u','request-1',300);s=await wallet.snapshot('u');
  assert.equal(s.pointsBalance,100);assert.equal(s.permanentAvailable,100);assert.equal(s.pointsReserved,0);
  await wallet.capture('u','request-1',300);assert.equal((await wallet.snapshot('u')).pointsBalance,100);
  assert.equal((await store.all("SELECT * FROM points_ledger WHERE idempotency_key='request-1'")).length,1);
});
test('failure after expiry does not turn a held monthly gift into permanent points',async t=>{
  const {store,wallet,time}=await fixture();t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'cycle-1',1000,2000);await wallet.reserve('u','failed',800);time(2500);
  await wallet.release('u','failed');await wallet.release('u','failed');
  const s=await wallet.snapshot('u');assert.equal(s.pointsBalance,100);assert.equal(s.pointsReserved,0);assert.equal(s.permanentAvailable,100);
});
test('cost above the old hold uses a new active gift before permanent points',async t=>{
  const {store,wallet,time}=await fixture();t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'old',1000,2000);await wallet.reserve('u','large',800);time(2500);
  await wallet.creditMonthly('u',2000,'new',2000,3000);
  const result=await wallet.capture('u','large',1200);assert.equal(result.settled,true);
  const s=await wallet.snapshot('u');assert.equal(s.permanentAvailable,100);assert.equal(s.monthlyAvailable,16);assert.equal(s.pointsReserved,0);
});
test('insufficient settlement keeps the original allocation until a top-up completes it',async t=>{
  const {store,wallet,time}=await fixture(0);t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'old',1000,2000);await wallet.reserve('u','debt',800);time(2500);
  const pending=await wallet.capture('u','debt',1200);assert.equal(pending.settled,false);assert.equal(pending.requiredUnits,400);
  assert.equal((await wallet.snapshot('u')).pointsReserved,8);
  await wallet.creditPermanent('u',400,'top-up');await wallet.capture('u','debt',1200);
  assert.equal((await wallet.snapshot('u')).pointsBalance,0);assert.equal((await wallet.snapshot('u')).pointsReserved,0);
});
test('cycle credits are idempotent and an already-expired cycle never becomes spendable',async t=>{
  const {store,wallet,time}=await fixture();t.after(()=>store.close());
  await wallet.creditMonthly('u',1000,'same-cycle',1000,2000);await wallet.creditMonthly('u',1000,'same-cycle',1000,2000);
  assert.equal((await wallet.snapshot('u')).pointsBalance,110);
  await assert.rejects(wallet.creditMonthly('u',1100,'same-cycle',1000,2000),e=>e.code==='WALLET_CREDIT_CONFLICT');
  time(3000);await wallet.creditMonthly('u',1200,'past-cycle',2000,2500);
  assert.equal((await wallet.snapshot('u')).pointsBalance,100);
});
test('two concurrent reservations cannot spend the same balance twice',async t=>{
  const {store,wallet}=await fixture(20);t.after(()=>store.close());
  const results=await Promise.allSettled([wallet.reserve('u','a',1500),wallet.reserve('u','b',1500)]);
  assert.equal(results.filter(v=>v.status==='fulfilled').length,1);
  const s=await wallet.snapshot('u');assert.equal(s.pointsReserved,15);assert.equal(s.pointsAvailable,5);
});
test('legacy reservation mismatch fails without changing balances or inventing a refund',async t=>{
  const {store,wallet}=await fixture();t.after(()=>store.close());await store.run("UPDATE users SET points_reserved=1 WHERE id='u'");
  await assert.rejects(wallet.snapshot('u'),e=>e.code==='WALLET_LEGACY_RESERVATION_INVALID');
  assert.equal((await store.get("SELECT points_balance FROM users WHERE id='u'")).points_balance,100);
  assert.equal((await store.get('SELECT COUNT(*) AS n FROM confirmations')).n,0);
});
test('unexpected old-version balance writes are detected rather than overwritten',async t=>{
  const {store,wallet}=await fixture();t.after(()=>store.close());await wallet.snapshot('u');
  await store.run("UPDATE users SET points_balance=101 WHERE id='u'");
  await assert.rejects(wallet.snapshot('u'),e=>e.code==='WALLET_LEGACY_WRITE_DETECTED');
  assert.equal((await store.get("SELECT points_balance FROM users WHERE id='u'")).points_balance,101);
});
