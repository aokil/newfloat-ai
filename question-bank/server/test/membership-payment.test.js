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
test('catalogue sells three point packages and rejects new membership orders',async t=>{
  const f=await fixture(t);
  const p=(await call(f.app,'GET','/v1/payments/packages',f.user.accessToken)).json();
  assert.deepEqual(p.items.map(i=>[i.amountMinor,i.points,i.cardStyle]),[[990,100,'go'],[1990,300,'plus'],[2990,600,'plus']]);
  assert.deepEqual((await call(f.app,'GET','/v1/memberships/catalog',f.user.accessToken)).json().items,[]);
  const member=await call(f.app,'POST','/v1/payments/orders',f.user.accessToken,{packageId:'membership-go',membershipBilling:'lifetime'},'retired');
  assert.equal(member.statusCode,410);assert.equal((await f.app.store.get('SELECT COUNT(*) n FROM payment_orders')).n,0);
});
test('verified point purchases upgrade the card and a later smaller package cannot downgrade Plus',async t=>{
  const f=await fixture(t),small=await f.create('points-100','small');
  assert.equal((await f.me()).pointsCardStyle,'default');
  assert.equal((await f.notify(small)).body,'success');assert.equal((await f.notify(small)).body,'success');
  let account=await f.me();assert.equal(account.pointsCardStyle,'go');assert.equal(account.pointsAvailable,110);
  assert.equal(account.entitlements.aiImportAllowed,true);assert.equal(account.membershipBenefits.importLimit,3000);
  const medium=await f.create('points-300');assert.equal((await f.notify(medium)).body,'success');
  const again=await f.create('points-100','small-again');assert.equal((await f.notify(again)).body,'success');
  account=await f.me();assert.equal(account.pointsCardStyle,'plus');assert.equal(account.pointsAvailable,510);
  assert.equal(account.membershipBenefits.libraryCapacity,10000);assert.equal(account.membershipBenefits.historyLimit,500);
  assert.equal((await f.create('points-100','small-again')).orderId,again.orderId);
});
test('wrong amount and a reused provider trade cannot upgrade the points card',async t=>{
  const f=await fixture(t),small=await f.create('points-100'),large=await f.create('points-600');
  f.state.amountOffset=1;assert.equal((await f.notify(large)).body,'failure');assert.equal((await f.me()).pointsCardStyle,'default');
  f.state.amountOffset=0;f.state.trade='one_provider_trade';assert.equal((await f.notify(small)).body,'success');
  assert.equal((await f.notify(large)).body,'failure');assert.equal((await f.me()).pointsCardStyle,'go');
});
