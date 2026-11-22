import test from 'node:test';
import assert from 'node:assert/strict';
import {testApp,register,call} from './helpers.js';

/** Local provider receipts only; never connects to Alipay or moves real money. */
async function fixture(t){
  const state={amountOffset:0,trade:null};
  const payment={ready:true,environment:'sandbox',appId:'synthetic-app',sellerId:'synthetic-seller',
    async precreate(row){return {verified:true,orderId:row.id,qrCode:'https://qr.alipay.com/synthetic'};},
    async query(row){return receipt(row,'query');},verifyNotify(_raw,row){return receipt(row,'notify');}};
  function receipt(row,source){return {verified:true,orderId:row.id,amountMinor:row.amount_minor+state.amountOffset,environment:'sandbox',appId:payment.appId,sellerId:payment.sellerId,
    tradeNo:state.trade??'trade_'+row.id,status:'TRADE_SUCCESS',source,paid:true};}
  const app=await testApp({paymentTransport:payment});t.after(()=>app.close());const user=await register(app,'synthetic-member');
  const create=async(product,key=product)=>{const r=await call(app,'POST','/v1/payments/orders',user.accessToken,{packageId:product,...(product.startsWith('membership-')?{membershipBilling:'lifetime'}:{})},key);assert.equal(r.statusCode,200,r.body);return r.json();};
  const notify=order=>app.inject({method:'POST',url:'/v1/payments/alipay/notify',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'out_trade_no='+order.orderId+'&sign=synthetic'});
  const me=async()=>{const r=await call(app,'GET','/v1/me',user.accessToken);assert.equal(r.statusCode,200,r.body);return r.json().account;};
  return {app,user,state,create,notify,me};
}
test('member catalogue is separate from permanent point packages and advertises cloud as unavailable',async t=>{
  const f=await fixture(t);const p=(await call(f.app,'GET','/v1/payments/packages',f.user.accessToken)).json();assert.equal(p.items.length,3);
  const m=(await call(f.app,'GET','/v1/memberships/catalog',f.user.accessToken)).json();assert.deepEqual(m.items.map(i=>[i.plan,i.amountMinor,i.points,i.aiImports]),[['go',1600,120,5],['plus',2660,320,15]]);assert(m.items.every(i=>i.cloudEngine===false));
  assert.deepEqual(m.items.map(i=>[i.plan,i.importLimit,i.libraryCapacity]),[['go',5000,20000],['plus',10000,30000]]);
  assert(m.items.every(i=>i.moveArrows===true&&i.automaticMoves===true));
  assert(m.items.every(i=>i.allowPointsExchange===true&&i.pointsPerImportExchange===5));
  assert.equal(m.version,2);assert.equal(m.billing,'lifetime');
  assert(m.items.every(i=>i.billing==='lifetime'&&i.permanent===true&&i.lifetimeUpdates===true));
});
test('Go callback retries fulfill permanent membership and purchase gifts exactly once',async t=>{
  const f=await fixture(t),order=await f.create('membership-go');assert.equal(order.productType,'membership');assert.equal(order.amountMinor,1600);
  assert.equal((await f.notify(order)).body,'success');assert.equal((await f.notify(order)).body,'success');
  const a=await f.me();assert.equal(a.membership,'go');assert.equal(a.membershipBenefits.aiImports.granted,7);assert.equal(a.wallet.monthlyAvailable,0);assert.equal(a.wallet.permanentAvailable,130);
  assert.equal(a.membershipBenefits.permanent,true);assert.equal(a.membershipBenefits.expiresAt,null);
  assert(Date.parse(a.membershipBenefits.validUntil)<=Date.now()+7*86400000+1000);
  const result=(await call(f.app,'GET','/v1/payments/orders/'+order.orderId,f.user.accessToken)).json();assert.equal(result.fulfilled,true);assert.equal(result.membership.plan,'go');assert.equal(result.membership.activation,'active');
  assert.equal(result.membershipBilling,'lifetime');assert.equal(result.membership.endsAt,null);
  assert.equal((await f.app.store.get("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id=? AND reason LIKE '%购买赠点'",f.user.principal.userId)).n,1);
});
test('Plus purchase permanently upgrades Go immediately and preserves its previously granted gifts',async t=>{
  const f=await fixture(t),go=await f.create('membership-go');await f.notify(go);const plus=await f.create('membership-plus');await f.notify(plus);
  const a=await f.me();assert.equal(a.membership,'plus');assert.equal(a.membershipBenefits.nextPlan,null);assert.equal(a.membershipBenefits.aiImports.granted,22);assert.equal(a.wallet.permanentAvailable,450);
  await f.notify(plus);assert.equal((await f.me()).membershipBenefits.aiImports.granted,22);
});
test('same or lower permanent membership cannot create another chargeable order',async t=>{
  const f=await fixture(t),plus=await f.create('membership-plus');await f.notify(plus);
  for(const product of ['membership-go','membership-plus']){
    const result=await call(f.app,'POST','/v1/payments/orders',f.user.accessToken,{packageId:product,membershipBilling:'lifetime'},'repeat-'+product);
    assert.equal(result.statusCode,409);assert.equal(result.json().error.code,'MEMBERSHIP_ALREADY_OWNED');
  }
  assert.equal((await f.create('membership-plus')).orderId,plus.orderId);
  const a=await f.me();assert.equal(a.membership,'plus');assert.equal(a.membershipBenefits.aiImports.granted,17);assert.equal(a.wallet.permanentAvailable,330);
});
test('old clients cannot create a permanent order while still showing monthly purchase terms',async t=>{
  const f=await fixture(t);
  const old=await call(f.app,'POST','/v1/payments/orders',f.user.accessToken,{packageId:'membership-go'},'old-client');
  assert.equal(old.statusCode,409);assert.equal(old.json().error.code,'MEMBERSHIP_CLIENT_UPDATE_REQUIRED');
  assert.equal((await f.app.store.get('SELECT COUNT(*) n FROM payment_orders')).n,0);
});
test('wrong amounts and reused provider trades cannot create membership entitlements',async t=>{
  const f=await fixture(t),go=await f.create('membership-go');f.state.amountOffset=1;assert.equal((await f.notify(go)).body,'failure');assert.equal((await f.me()).membership,'free');
  f.state.amountOffset=0;f.state.trade='one_provider_trade';assert.equal((await f.notify(go)).body,'success');const plus=await f.create('membership-plus');assert.equal((await f.notify(plus)).body,'failure');assert.equal((await f.me()).membership,'go');
});
test('permanent point purchases and order idempotency continue to work independently of membership',async t=>{
  const f=await fixture(t),order=await f.create('points-100','same');assert.equal((await f.create('points-100','same')).orderId,order.orderId);
  assert.equal((await f.notify(order)).body,'success');await f.notify(order);const a=await f.me();assert.equal(a.wallet.permanentAvailable,110);assert.equal(a.wallet.monthlyAvailable,0);assert.equal(a.membership,'free');
  assert.equal((await call(f.app,'POST','/v1/payments/orders',f.user.accessToken,{packageId:'membership-go',membershipBilling:'lifetime'},'same')).statusCode,409);
});
test('zero balance accounts can reserve initial AI imports, while unauthorised repair is rejected',async t=>{
  const f=await fixture(t);const {setPointsBalance}=await import('./helpers.js');await setPointsBalance(f.app.store,f.user.principal.userId,0);
  const id='11111111-1111-4111-8111-111111111111',hash='a'.repeat(64);
  let r=await call(f.app,'POST','/v1/memberships/ai-imports/'+id+'/start',f.user.accessToken,{sourceHash:hash});assert.equal(r.statusCode,200,r.body);
  r=await call(f.app,'POST','/v1/memberships/ai-imports/'+id+'/finish',f.user.accessToken,{success:true});assert.equal(r.json().state,'consumed');
  const a=await f.me();assert.equal(a.membershipBenefits.aiImports.available,1);assert.equal(a.pointsBalance,0);
  r=await call(f.app,'POST','/v1/ai/import-repair',f.user.accessToken,{sourceHash:hash},'without-ticket');assert.equal(r.statusCode,403);assert.equal(r.json().error.code,'AI_IMPORT_TICKET_REQUIRED');
});
