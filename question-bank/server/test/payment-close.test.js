import test from 'node:test';
import assert from 'node:assert/strict';
import {AlipayFailure} from '../src/alipay.js';
import {testApp,register,call} from './helpers.js';

/** In-process, synthetic provider only. No Alipay calls or real payment credentials. */
async function fixture(t){
  const state={trades:new Map(),closes:0,creates:0,closeError:null,queryError:null,notFoundCloses:0,notFoundQueries:0,invalidClose:false,onClose:null};
  const payment={ready:true,environment:'sandbox',appId:'synthetic-app',sellerId:'synthetic-seller',
    async precreate(row){state.creates++;state.trades.set(row.id,'WAIT_BUYER_PAY');return {verified:true,orderId:row.id,qrCode:'https://qr.alipay.com/synthetic-'+row.id};},
    async query(row){
      if(state.notFoundQueries>0){state.notFoundQueries--;throw new AlipayFailure('PAYMENT_TRADE_NOT_FOUND');}
      if(state.queryError)throw new AlipayFailure(state.queryError);return receipt(row,'query');
    },
    async close(row){
      state.closes++;
      if(state.onClose)await state.onClose(row);
      if(state.notFoundCloses>0){state.notFoundCloses--;throw new AlipayFailure('PAYMENT_TRADE_NOT_FOUND');}
      if(state.closeError)throw new AlipayFailure(state.closeError);
      if(state.trades.get(row.id)==='TRADE_SUCCESS')throw new AlipayFailure('PAYMENT_ALREADY_PAID');
      state.trades.set(row.id,'TRADE_CLOSED');
      return {verified:true,closed:true,source:'close',orderId:row.id,tradeNo:'trade_'+row.id,
        environment:payment.environment,appId:state.invalidClose?'wrong-app':payment.appId,sellerId:payment.sellerId};
    },verifyNotify(_raw,row){return receipt(row,'notify');}};
  function receipt(row,source){
    const status=state.trades.get(row.id);
    return {verified:true,orderId:row.id,tradeNo:'trade_'+row.id,amountMinor:row.amount_minor,
      environment:payment.environment,appId:payment.appId,sellerId:payment.sellerId,status,source,paid:status==='TRADE_SUCCESS'};
  }
  const app=await testApp({paymentTransport:payment});t.after(()=>app.close());const user=await register(app,'synthetic-close');
  const create=async(product,key=product)=>{const r=await call(app,'POST','/v1/payments/orders',user.accessToken,{packageId:product},key);assert.equal(r.statusCode,200,r.body);return r.json();};
  const close=order=>call(app,'POST','/v1/payments/orders/'+order.orderId+'/close',user.accessToken,{});
  const notify=order=>app.inject({method:'POST',url:'/v1/payments/alipay/notify',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'out_trade_no='+order.orderId+'&sign=synthetic'});
  return {app,user,state,create,close,notify};
}

test('switching point packages closes old cashiers and uses a fresh order',async t=>{
  const f=await fixture(t),go=await f.create('points-100','go-first');
  let r=await f.close(go);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'closed');assert.equal(r.json().closeConfirmed,true);assert.equal(r.json().qrCode,null);
  const plus=await f.create('points-600','plus');r=await f.close(plus);assert.equal(r.json().closeConfirmed,true);
  const again=await f.create('points-100','go-second');assert.notEqual(again.orderId,go.orderId);assert.equal(again.status,'pending');
  const replay=await f.create('points-100','go-first');assert.equal(replay.status,'closed');assert.equal(f.state.creates,3);
  const me=await call(f.app,'GET','/v1/me',f.user.accessToken);assert.equal(me.json().account.membership,'free');
});

for(const [product,cents,points] of [['points-100',990,100],['points-300',1990,300],['points-600',2990,600]]){
  test('closing an unpaid order then purchasing '+product+' retains the point package amount and type',async t=>{
    const f=await fixture(t),plus=await f.create('points-600','original-closed');
    const closed=await f.close(plus);assert.equal(closed.statusCode,200,closed.body);assert.equal(closed.json().closeConfirmed,true);
    const topup=await f.create(product);assert.equal(topup.packageId,product);assert.equal(topup.productType,'points');
    assert.equal(topup.amountMinor,cents);assert.equal(topup.points,points);assert.equal(topup.membership,null);assert.notEqual(topup.orderId,plus.orderId);
  });
}

test('missing trade is cancelled locally and point checkout continues without waiting for sync',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.notFoundCloses=2;f.state.notFoundQueries=2;
  const closed=await f.close(plus);assert.equal(closed.statusCode,200,closed.body);assert.equal(closed.json().closeConfirmed,true);
  assert.equal(closed.json().closeAttempts,1);assert.equal(f.state.closes,1);
  assert.equal(closed.json().merchantCancelled,true);assert.equal(closed.json().providerCloseConfirmed,false);
  assert.equal(closed.json().closeReason,'trade_not_found_cancelled');assert.equal(closed.json().errorCode,null);assert.equal(closed.json().qrCode,null);
  const points=await f.create('points-100');assert.equal(points.productType,'points');assert.equal(points.status,'pending');
});

test('persistent missing trade cancellation is idempotent and cannot revive its old cashier',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.notFoundCloses=99;f.state.notFoundQueries=99;
  const r=await f.close(plus);assert.equal(r.json().status,'closed');assert.equal(r.json().closeConfirmed,true);
  assert.equal(r.json().closeAttempts,1);assert.equal(f.state.closes,1);
  assert.equal(r.json().errorCode,null);assert.equal(r.json().queryErrorCode,'PAYMENT_TRADE_NOT_FOUND');
  const again=await f.close(plus);assert.equal(again.json().merchantCancelled,true);assert.equal(f.state.closes,1);
  assert.equal((await f.create('points-600')).status,'closed');assert.equal(f.state.creates,1);
  assert.equal((await f.notify(plus)).body,'success');
  const queried=await call(f.app,'GET','/v1/payments/orders/'+plus.orderId,f.user.accessToken);
  assert.equal(queried.json().status,'closed');assert.equal(queried.json().merchantCancelled,true);assert.equal(queried.json().providerCloseConfirmed,false);
  const replacement=await f.create('points-600','replacement-plus');assert.notEqual(replacement.orderId,plus.orderId);
});

test('a missing close response with a verified unpaid trade also ends the merchant attempt',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.closeError='PAYMENT_TRADE_NOT_FOUND';
  const r=await f.close(plus);assert.equal(r.json().status,'closed');assert.equal(r.json().closeConfirmed,true);
  assert.equal(r.json().merchantCancelled,true);assert.equal(r.json().providerCloseConfirmed,false);assert.equal(r.json().qrCode,null);
});

test('a late genuine payment after merchant cancellation still credits the original package exactly once',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.notFoundCloses=1;f.state.notFoundQueries=1;
  assert.equal((await f.close(plus)).json().merchantCancelled,true);
  const topup=await f.create('points-100');
  f.state.trades.set(plus.orderId,'TRADE_SUCCESS');assert.equal((await f.notify(plus)).body,'success');assert.equal((await f.notify(plus)).body,'success');
  const me=await call(f.app,'GET','/v1/me',f.user.accessToken);assert.equal(me.json().account.pointsCardStyle,'plus');
  assert.equal(me.json().account.pointsAvailable,610);
  const original=await call(f.app,'GET','/v1/payments/orders/'+plus.orderId,f.user.accessToken);
  assert.equal(original.json().status,'paid');assert.equal(original.json().merchantCancelled,false);
  const pending=await call(f.app,'GET','/v1/payments/orders/'+topup.orderId,f.user.accessToken);assert.equal(pending.json().status,'pending');
});

test('a paid callback winning the missing-trade cancellation race is never overwritten',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.notFoundCloses=1;f.state.notFoundQueries=1;
  f.state.onClose=async()=>{f.state.trades.set(plus.orderId,'TRADE_SUCCESS');assert.equal((await f.notify(plus)).body,'success');};
  const r=await f.close(plus);assert.equal(r.json().status,'paid');assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().merchantCancelled,false);
});

test('missing close response combined with an unavailable query is not treated as missing confirmation',async t=>{
  const f=await fixture(t),plus=await f.create('points-600');f.state.notFoundCloses=1;f.state.queryError='PAYMENT_PROVIDER_UNAVAILABLE';
  const r=await f.close(plus);assert.equal(r.json().status,'pending');assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().merchantCancelled,false);
  assert.equal(r.json().queryErrorCode,'PAYMENT_PROVIDER_UNAVAILABLE');
});

test('confirmed closes are idempotent and pending callbacks cannot reopen the cashier',async t=>{
  const f=await fixture(t),go=await f.create('points-100');await f.close(go);await f.close(go);assert.equal(f.state.closes,1);
  f.state.trades.set(go.orderId,'WAIT_BUYER_PAY');assert.equal((await f.notify(go)).body,'success');
  const r=await call(f.app,'GET','/v1/payments/orders/'+go.orderId,f.user.accessToken);assert.equal(r.json().status,'closed');assert.equal(r.json().qrCode,null);
});

test('a payment winning the close race is fulfilled once and is not reported as cancelled',async t=>{
  const f=await fixture(t),go=await f.create('points-100');f.state.trades.set(go.orderId,'TRADE_SUCCESS');
  const r=await f.close(go);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'paid');assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().pointsCredited,100);
  await f.close(go);assert.equal(f.state.closes,1);
  const me=await call(f.app,'GET','/v1/me',f.user.accessToken);assert.equal(me.json().account.pointsCardStyle,'go');
});

test('an in-flight close cannot overwrite an accepted paid callback or trigger a refund marker',async t=>{
  const f=await fixture(t),go=await f.create('points-100');
  f.state.onClose=async()=>{f.state.trades.set(go.orderId,'TRADE_SUCCESS');assert.equal((await f.notify(go)).body,'success');f.state.trades.set(go.orderId,'WAIT_BUYER_PAY');};
  const r=await f.close(go);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'paid');assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().refundReviewRequired,false);
});

test('failed close and unavailable query preserve the original pending order',async t=>{
  const f=await fixture(t),go=await f.create('points-100');f.state.closeError='PAYMENT_PROVIDER_UNAVAILABLE';f.state.queryError='PAYMENT_PROVIDER_UNAVAILABLE';
  const r=await f.close(go);assert.equal(r.statusCode,200,r.body);assert.equal(r.json().status,'pending');assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().errorCode,'PAYMENT_PROVIDER_UNAVAILABLE');
  assert.equal(r.json().closeAttempts,1);assert.equal(f.state.closes,1);
  assert.equal((await f.create('points-100')).orderId,go.orderId);assert.equal(f.state.creates,1);
});

test('wrong close context without confirming query evidence cannot cancel an order',async t=>{
  const f=await fixture(t),go=await f.create('points-100');f.state.invalidClose=true;f.state.queryError='PAYMENT_PROVIDER_UNAVAILABLE';
  const r=await f.close(go);assert.equal(r.json().closeConfirmed,false);assert.equal(r.json().status,'pending');assert.equal(r.json().errorCode,'PAYMENT_INVALID_RECEIPT');
});

test('close is owner-only and rejects unsupported fields',async t=>{
  const f=await fixture(t),go=await f.create('points-100'),other=await register(f.app,'synthetic-other');
  const endpoint='/v1/payments/orders/'+go.orderId+'/close';
  assert.equal((await call(f.app,'POST',endpoint,other.accessToken,{})).statusCode,404);
  assert.equal((await call(f.app,'POST',endpoint,f.user.accessToken,{refund:true})).statusCode,400);assert.equal(f.state.closes,0);
});

test('a still-running precreate is not marked closed from a missing-trade response',async t=>{
  const f=await fixture(t),go=await f.create('points-100');
  await f.app.store.run("UPDATE payment_orders SET status='creating',qr_code=NULL,precreate_at=? WHERE id=?",Date.now(),go.orderId);
  const r=await f.close(go);assert.equal(r.statusCode,409,r.body);assert.equal(f.state.closes,0);
});
