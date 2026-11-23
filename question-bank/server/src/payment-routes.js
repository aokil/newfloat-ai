import {randomBytes} from 'node:crypto';
import {ApiError,authenticate,fields,sha256,text} from './security.js';
import {points} from './account.js';
import {availablePoints} from './point-values.js';
import {POINTS_PACKAGES,AlipayFailure,amountString,pointsCardStyle} from './alipay.js';
import {membershipAccount,membershipPlan} from './membership.js';
import {pointWallet} from './point-wallet.js';

const NOTIFY_PATH='/v1/payments/alipay/notify';
const NOTIFY_LIMIT=16*1024;
const OPEN_STATUSES=new Set(['creating','pending','uncertain']);
const QUERY_INTERVAL=12000;
const RECOVERY_INTERVAL=30000;
const CANCELLED_MISSING_TRADE='PAYMENT_CANCELLED_TRADE_NOT_FOUND';
function absent(){throw new ApiError(404,'PAYMENT_ORDER_NOT_FOUND','支付订单不存在');}
function unavailable(payment){throw new ApiError(503,payment?.unavailableReason||'PAYMENT_NOT_OPEN','支付宝支付暂未就绪，请稍后重试');}
function validTransport(payment){return payment?.ready===true&&['precreate','query','verifyNotify'].every(key=>typeof payment[key]==='function');}
function form(body){
  if(!Buffer.isBuffer(body)||body.length>NOTIFY_LIMIT)throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知格式无效');
  let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(body);}catch{throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知格式无效');}
  const pieces=raw.split('&');
  if(pieces.length<1||pieces.length>64)throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知格式无效');
  const result=Object.create(null);
  for(const piece of pieces){
    const at=piece.indexOf('=');if(at<1)throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知格式无效');
    let key,value;try{key=decodeURIComponent(piece.slice(0,at).replace(/\+/gu,' '));value=decodeURIComponent(piece.slice(at+1).replace(/\+/gu,' '));}catch{throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知格式无效');}
    if(!/^[a-z][a-z0-9_]{0,63}$/u.test(key)||Object.hasOwn(result,key)||value.length>8192||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))
      throw new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知含重复或无效字段');
    result[key]=value;
  }
  return result;
}
function errorCode(error){return error instanceof AlipayFailure?error.code:'PAYMENT_PROVIDER_UNAVAILABLE';}
function receiptMatches(order,receipt){
  return receipt?.verified===true&&receipt.orderId===order.id&&receipt.amountMinor===order.amount_minor&&
    receipt.environment===order.environment&&receipt.appId===order.app_id&&receipt.sellerId===order.seller_id&&
    typeof receipt.tradeNo==='string'&&/^[A-Za-z0-9_]{1,64}$/u.test(receipt.tradeNo)&&
    ['WAIT_BUYER_PAY','TRADE_CLOSED','TRADE_SUCCESS','TRADE_FINISHED'].includes(receipt.status)&&
    ['notify','query'].includes(receipt.source)&&receipt.paid===['TRADE_SUCCESS','TRADE_FINISHED'].includes(receipt.status);
}

/** Register on the existing authenticated backend; positive points are not required. */
export async function registerPaymentRoutes(app,{store,auth,payment=null}){
  const members=membershipAccount(store);
  async function own(req){
    if(typeof req.params.id!=='string'||!/^pay_[a-f0-9]{32}$/u.test(req.params.id))absent();
    const row=await store.get('SELECT * FROM payment_orders WHERE id=? AND owner_id=?',req.params.id,req.auth.user_id);
    if(!row)absent();return row;
  }
  async function view(row,checkError=null){
    await members.snapshot(row.owner_id);
    const user=await pointWallet(store).user(row.owner_id),plan=membershipPlan(row.package_id);
    const membership=plan?await members.orderReceipt(row.owner_id,row.id):null;
    const offer=plan?await members.offerForOrder(row.owner_id,row.id):null;
    const merchantCancelled=row.status==='closed'&&row.error_code===CANCELLED_MISSING_TRADE;
    if(!user)absent();
    return {orderId:row.id,status:row.status,packageId:row.package_id,title:row.package_title,
      amountMinor:row.amount_minor,priceCents:row.amount_minor,amount:amountString(row.amount_minor),currency:'CNY',points:row.points,
      productType:plan?'membership':'points',membershipBilling:plan?(offer?.billing??'monthly'):null,
      fulfilled:row.status==='paid'&&(!plan||membership?.fulfilled===true),membership,
      credited:row.status==='paid',pointsCredited:row.status==='paid'&&(!plan||Date.parse(membership?.startsAt)<=row.paid_at)?row.points:0,pointsBalance:user.points_balance,
      pointsAvailable:availablePoints(user),
      qrCode:row.status==='pending'&&row.expires_at>Date.now()?row.qr_code:null,
      expiresAt:new Date(row.expires_at).toISOString(),paidAt:row.paid_at===null?null:new Date(row.paid_at).toISOString(),
      errorCode:checkError??(merchantCancelled?null:row.error_code),confirmationRequired:OPEN_STATUSES.has(row.status),
      expired:row.expires_at<=Date.now(),recoveryEligible:OPEN_STATUSES.has(row.status)&&row.qr_code===null&&row.expires_at>Date.now(),
      refundReviewRequired:row.error_code==='PAYMENT_REFUND_REVIEW_REQUIRED',merchantCancelled,
      providerCloseConfirmed:row.status==='closed'&&!merchantCancelled,
      closeReason:merchantCancelled?'trade_not_found_cancelled':row.status==='closed'?'provider_closed':null};
  }
  async function cancelMissingTrade(orderId){
    return await store.transaction(async()=>{
      const row=await store.get('SELECT * FROM payment_orders WHERE id=?',orderId);
      if(!row)throw new AlipayFailure('PAYMENT_OWNER_NOT_FOUND');
      // This is the user's merchant-side cancellation policy, not an Alipay close receipt.
      // A payment that won the race must still keep its original fulfillment.
      if(row.status==='paid'||row.status==='closed')return row;
      const ledger=await store.get('SELECT delta FROM points_ledger WHERE user_id=? AND idempotency_key=?',row.owner_id,`alipay:${row.id}`);
      const membership=membershipPlan(row.package_id)?await members.orderReceipt(row.owner_id,row.id):null;
      if(ledger||membership)throw new AlipayFailure('PAYMENT_LEDGER_INCONSISTENT');
      const now=Date.now(),proof=sha256(JSON.stringify({source:'merchant-cancel',reason:'trade-not-found',orderId:row.id}));
      await store.run("UPDATE payment_orders SET status='closed',qr_code=NULL,error_code=?,receipt_hash=?,checked_at=?,updated_at=? WHERE id=? AND status<>'paid'",
        CANCELLED_MISSING_TRADE,proof,now,now,row.id);
      await store.audit(row.owner_id,'payment-order-cancelled',row.id,{provider:'alipay',reason:'trade-not-found',providerCloseConfirmed:false});
      return await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
    });
  }
  async function settleClose(orderId,receipt){
    return await store.transaction(async()=>{
      const row=await store.get('SELECT * FROM payment_orders WHERE id=?',orderId);
      if(!row||receipt?.verified!==true||receipt.source!=='close'||receipt.closed!==true||receipt.orderId!==row.id||
        receipt.environment!==row.environment||receipt.appId!==row.app_id||receipt.sellerId!==row.seller_id||
        (receipt.tradeNo!==null&&(typeof receipt.tradeNo!=='string'||!/^[A-Za-z0-9_]{1,64}$/u.test(receipt.tradeNo))))
        throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      // A callback may have settled the payment while the close request was in flight.
      // Closing an unpaid trade is never a refund or a reason to reverse fulfilled rights.
      if(row.status==='paid'||row.status==='closed')return row;
      if(row.trade_no!==null&&receipt.tradeNo!==null&&row.trade_no!==receipt.tradeNo)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      if(receipt.tradeNo!==null&&await store.get('SELECT id FROM payment_orders WHERE environment=? AND trade_no=? AND id<>?',row.environment,receipt.tradeNo,row.id))
        throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      const ledger=await store.get('SELECT delta FROM points_ledger WHERE user_id=? AND idempotency_key=?',row.owner_id,`alipay:${row.id}`);
      const membership=membershipPlan(row.package_id)?await members.orderReceipt(row.owner_id,row.id):null;
      if(ledger||membership)throw new AlipayFailure('PAYMENT_LEDGER_INCONSISTENT');
      const now=Date.now(),proof=sha256(JSON.stringify({source:'close',orderId:row.id,tradeNo:receipt.tradeNo,
        environment:receipt.environment,appId:receipt.appId,sellerId:receipt.sellerId}));
      await store.run("UPDATE payment_orders SET status='closed',qr_code=NULL,trade_no=COALESCE(?,trade_no),receipt_hash=?,checked_at=?,updated_at=?,error_code=NULL WHERE id=?",
        receipt.tradeNo,proof,now,now,row.id);
      await store.audit(row.owner_id,'payment-order-closed',row.id,{provider:'alipay',reason:'product-switch'});
      return await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
    });
  }
  async function recover(row){
    const claimed=await store.transaction(async()=>{
      const fresh=await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
      if(!fresh||!OPEN_STATUSES.has(fresh.status)||fresh.qr_code!==null||fresh.expires_at<=Date.now()||
        Date.now()-fresh.precreate_at<RECOVERY_INTERVAL)return null;
      await store.run("UPDATE payment_orders SET status='uncertain',precreate_at=?,updated_at=? WHERE id=?",Date.now(),Date.now(),fresh.id);
      return fresh;
    });
    if(!claimed)return {row:await store.get('SELECT * FROM payment_orders WHERE id=?',row.id),error:null};
    let result,failure=null;
    try{
      result=await payment.precreate(claimed);
      if(result?.verified!==true||result.orderId!==claimed.id||typeof result.qrCode!=='string')throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
    }catch(error){failure=errorCode(error);}
    const fresh=await store.transaction(async()=>{
      const current=await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
      if(OPEN_STATUSES.has(current.status)&&current.qr_code===null){
        if(failure)await store.run("UPDATE payment_orders SET status='uncertain',error_code=?,updated_at=? WHERE id=?",failure,Date.now(),current.id);
        else await store.run("UPDATE payment_orders SET status='pending',qr_code=?,error_code=NULL,updated_at=? WHERE id=?",result.qrCode,Date.now(),current.id);
      }
      return await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
    });
    return {row:fresh,error:failure};
  }
  async function settle(orderId,receipt){
    return await store.transaction(async()=>{
      const row=await store.get('SELECT * FROM payment_orders WHERE id=?',orderId);
      if(!row||!receiptMatches(row,receipt))throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      if(row.trade_no!==null&&row.trade_no!==receipt.tradeNo)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      const reused=await store.get('SELECT id FROM payment_orders WHERE environment=? AND trade_no=? AND id<>?',row.environment,receipt.tradeNo,row.id);
      if(reused)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      const key=`alipay:${row.id}`;
      const ledger=await store.get('SELECT delta FROM points_ledger WHERE user_id=? AND idempotency_key=?',row.owner_id,key);
      const plan=membershipPlan(row.package_id),membership=plan?await members.orderReceipt(row.owner_id,row.id):null;
      if(row.status==='paid'){
        if(plan?(!membership?.fulfilled||membership.plan!==plan.plan):(!ledger||ledger.delta!==row.points))throw new AlipayFailure('PAYMENT_LEDGER_INCONSISTENT');
        if(receipt.status==='TRADE_CLOSED'&&row.error_code!=='PAYMENT_REFUND_REVIEW_REQUIRED'){
          // Refund accounting is a separate explicit workflow. Never silently
          // remove points from a user based on a close notification.
          await store.run('UPDATE payment_orders SET error_code=?,checked_at=?,updated_at=? WHERE id=?','PAYMENT_REFUND_REVIEW_REQUIRED',Date.now(),Date.now(),row.id);
          await store.audit(null,'payment-refund-review',row.id,{provider:'alipay'});
        }
        return await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
      }
      // A late WAIT callback must not reopen a cancelled attempt or erase its cancellation reason.
      if(row.status==='closed'&&receipt.status==='WAIT_BUYER_PAY')return row;
      if(ledger||membership)throw new AlipayFailure('PAYMENT_LEDGER_INCONSISTENT');
      const now=Date.now(),proof=sha256(JSON.stringify({source:receipt.source,tradeNo:receipt.tradeNo,status:receipt.status,
        amountMinor:receipt.amountMinor,appId:receipt.appId,sellerId:receipt.sellerId,environment:receipt.environment}));
      if(receipt.paid){
        const user=await store.get('SELECT * FROM users WHERE id=?',row.owner_id);
        if(!user)throw new AlipayFailure('PAYMENT_OWNER_NOT_FOUND');
        if(plan)await members.fulfill(row.owner_id,row.id,plan.id);
        else await points(store,user,row.points,null,'支付宝套餐购买',key);
        await store.run("UPDATE payment_orders SET status='paid',trade_no=?,receipt_hash=?,paid_at=?,checked_at=?,updated_at=?,error_code=NULL WHERE id=?",receipt.tradeNo,proof,now,now,now,row.id);
        await store.audit(null,'payment-credited',row.id,{provider:'alipay',points:row.points,amountMinor:row.amount_minor});
      }else if(receipt.status==='TRADE_CLOSED'){
        await store.run("UPDATE payment_orders SET status='closed',trade_no=?,receipt_hash=?,checked_at=?,updated_at=?,error_code=NULL WHERE id=?",receipt.tradeNo,proof,now,now,row.id);
      }else{
        // A signed pending result cannot reopen an order that was already closed.
        const status=row.status==='closed'?'closed':'pending';
        await store.run('UPDATE payment_orders SET status=?,trade_no=?,receipt_hash=?,checked_at=?,updated_at=?,error_code=NULL WHERE id=?',status,receipt.tradeNo,proof,now,now,row.id);
      }
      return await store.get('SELECT * FROM payment_orders WHERE id=?',row.id);
    });
  }
  await app.register(async routes=>{
    // Parser is encapsulated to the payment plugin; upload/import parsers remain unchanged.
    routes.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'buffer',bodyLimit:NOTIFY_LIMIT},(req,body,done)=>{
      const contentType=req.headers['content-type']||'';
      if(/charset\s*=/iu.test(contentType)&&!/charset\s*=\s*(?:utf-8|"utf-8")\s*$/iu.test(contentType))return done(new ApiError(400,'PAYMENT_INVALID_NOTIFY','支付通知编码无效'));
      try{done(null,form(body));}catch(error){done(error);}
    });
    routes.get('/v1/payments/packages',{preHandler:auth},async()=>({provider:'alipay',currency:'CNY',
      ready:validTransport(payment),available:validTransport(payment),unavailableReason:validTransport(payment)?null:payment?.unavailableReason||'PAYMENT_NOT_OPEN',
      environment:payment?.environment||null,items:POINTS_PACKAGES.map(item=>({...item,label:item.title,priceCents:item.amountMinor,
        amount:amountString(item.amountMinor),cardStyle:pointsCardStyle(item.amountMinor),bonusPercent:Math.round((item.points*990/(item.amountMinor*100)-1)*100000)/1000}))}));
    routes.post('/v1/payments/orders',{preHandler:auth,bodyLimit:1024,config:{rateLimit:{max:6,timeWindow:'1 minute'}}},async req=>{
      fields(req.body,['packageId','membershipBilling']);const packageId=text(req.body.packageId,'套餐',1,64);
      const chosen=POINTS_PACKAGES.find(item=>item.id===packageId);
      if(!chosen&&membershipPlan(packageId)?.id!==packageId)throw new ApiError(400,'PAYMENT_PACKAGE_NOT_FOUND','套餐不存在');
      const idempotencyHash=sha256(text(req.headers['idempotency-key'],'Idempotency-Key',1,128)),requestHash=sha256(JSON.stringify({packageId}));
      const begin=await store.transaction(async()=>{
        req.auth=await authenticate(store,req);
        const previous=await store.get('SELECT * FROM payment_orders WHERE owner_id=? AND idempotency_hash=?',req.auth.user_id,idempotencyHash);
        if(previous){if(previous.request_hash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','幂等键已用于其他套餐');return {row:previous,replay:true};}
        if(!chosen)throw new ApiError(410,'MEMBERSHIP_SALES_ENDED','会员套餐已停止销售，请选择点数套餐');
        if(!validTransport(payment))unavailable(payment);
        const unresolved=await store.get("SELECT id FROM payment_orders WHERE owner_id=? AND status IN ('creating','uncertain') ORDER BY created_at LIMIT 1",req.auth.user_id);
        if(unresolved)throw new ApiError(409,'PAYMENT_CONFIRMATION_PENDING','已有订单待确认，请先查看原订单结果');
        const open=await store.get("SELECT COUNT(*) AS n FROM payment_orders WHERE owner_id=? AND status IN ('creating','pending','uncertain') AND expires_at>?",req.auth.user_id,Date.now());
        if(open.n>=5)throw new ApiError(429,'PAYMENT_TOO_MANY_PENDING','已有多个待确认订单，请先查看付款结果');
        const now=Date.now(),orderId=`pay_${randomBytes(16).toString('hex')}`;
        await store.run('INSERT INTO payment_orders(id,owner_id,idempotency_hash,request_hash,environment,app_id,seller_id,package_id,package_title,amount_minor,points,status,created_at,updated_at,expires_at,precreate_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          orderId,req.auth.user_id,idempotencyHash,requestHash,payment.environment,payment.appId,payment.sellerId,chosen.id,chosen.title,chosen.amountMinor,chosen.points,'creating',now,now,now+900000,now);
        await store.audit(req.auth.user_id,'payment-order-created',orderId,{provider:'alipay',packageId:chosen.id});
        return {row:await store.get('SELECT * FROM payment_orders WHERE id=?',orderId),replay:false};
      });
      if(begin.replay)return await view(begin.row);
      let result,error=null;
      try{result=await payment.precreate(begin.row);if(result?.verified!==true||result.orderId!==begin.row.id||typeof result.qrCode!=='string')throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');}
      catch(failure){error=errorCode(failure);}
      const row=await store.transaction(async()=>{
        const fresh=await store.get('SELECT * FROM payment_orders WHERE id=?',begin.row.id);
        if(fresh.status==='creating'){
          // An upstream error is not a signed assertion that no trade exists.
          // Reconcile this exact order rather than create another order number.
          if(error)await store.run("UPDATE payment_orders SET status='uncertain',error_code=?,updated_at=? WHERE id=?",error,Date.now(),fresh.id);
          else await store.run("UPDATE payment_orders SET status='pending',qr_code=?,error_code=NULL,updated_at=? WHERE id=?",result.qrCode,Date.now(),fresh.id);
        }
        return await store.get('SELECT * FROM payment_orders WHERE id=?',fresh.id);
      });
      // A provider request may finish after logout. Persist the result, but never
      // deliver an authenticated order after the initiating session is revoked.
      req.auth=await authenticate(store,req);
      return await view(row);
    });
    routes.post('/v1/payments/orders/:id/close',{preHandler:auth,bodyLimit:1024,config:{rateLimit:{max:12,timeWindow:'1 minute'}}},async req=>{
      fields(req.body,[]);
      let row=await own(req),failure=null,queryFailure=null,closeAttempts=0;
      if(row.status!=='closed'&&row.status!=='paid'){
        if(!validTransport(payment)||typeof payment.close!=='function')
          throw new ApiError(503,'PAYMENT_CLOSE_NOT_AVAILABLE','订单关闭服务暂不可用，请稍后重试');
        // Do not race an unfinished precreate/recovery and then mistake "not found" for a closed trade.
        if((row.status==='creating'||row.qr_code===null)&&Date.now()-row.precreate_at<RECOVERY_INTERVAL)
          throw new ApiError(409,'PAYMENT_CREATION_PENDING','原订单仍在创建，请稍后重试切换套餐');
        closeAttempts++;
        try{row=await settleClose(row.id,await payment.close(row));}
        catch(error){
          failure=errorCode(error);
          // Check for a concurrent successful payment once before ending this attempt.
          try{row=await settle(row.id,await payment.query(row));}
          catch(queryError){queryFailure=errorCode(queryError);row=await own(req);}
          if(row.status!=='paid'&&row.status!=='closed'&&failure==='PAYMENT_TRADE_NOT_FOUND'&&
            (queryFailure==='PAYMENT_TRADE_NOT_FOUND'||queryFailure===null&&row.status==='pending'))
            row=await cancelMissingTrade(row.id);
        }
      }
      req.auth=await authenticate(store,req);row=await own(req);
      // The attempt is ended either by provider closure or by the explicit merchant cancellation policy.
      const confirmed=row.status==='closed';
      if(!confirmed&&row.status!=='paid')await store.audit(req.auth.user_id,'payment-order-close-pending',row.id,
        {provider:'alipay',closeError:failure,queryError:queryFailure,attempts:closeAttempts});
      return {...await view(row,confirmed||row.status==='paid'?null:failure||'PAYMENT_CLOSE_UNCONFIRMED'),
        closeConfirmed:confirmed,closeAttempts,queryErrorCode:queryFailure};
    });
    routes.get('/v1/payments/orders/:id',{preHandler:auth,config:{rateLimit:{max:30,timeWindow:'1 minute'}}},async req=>{
      let row=await own(req),failure=null;
      if(OPEN_STATUSES.has(row.status)){
        if(!validTransport(payment))failure=payment?.unavailableReason||'PAYMENT_NOT_OPEN';
        else if(row.checked_at===null||Date.now()-row.checked_at>=QUERY_INTERVAL){
          const due=await store.transaction(async()=>{
            const fresh=await own(req);
            if(!OPEN_STATUSES.has(fresh.status)||(fresh.checked_at!==null&&Date.now()-fresh.checked_at<QUERY_INTERVAL))return false;
            await store.run('UPDATE payment_orders SET checked_at=? WHERE id=?',Date.now(),fresh.id);return true;
          });
          if(due){
            let allowRecovery=false;
            try{row=await settle(row.id,await payment.query(row));allowRecovery=row.status==='pending'&&row.qr_code===null;}
            catch(error){failure=errorCode(error);row=await own(req);allowRecovery=failure==='PAYMENT_TRADE_NOT_FOUND'&&row.qr_code===null;}
            if(allowRecovery&&row.expires_at>Date.now()){
              const recovered=await recover(row);row=recovered.row;failure=recovered.error??(row.qr_code?null:failure);
            }
          }
        }
      }
      req.auth=await authenticate(store,req);
      row=await own(req);
      return await view(row,failure);
    });
    routes.post(NOTIFY_PATH,{bodyLimit:NOTIFY_LIMIT,config:{rateLimit:{max:120,timeWindow:'1 minute'}}},async(req,reply)=>{
      reply.type('text/plain; charset=utf-8').header('Cache-Control','no-store');
      if(!validTransport(payment)||!req.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded'))return reply.code(200).send('failure');
      try{
        const data=req.body;
        if(typeof data?.out_trade_no!=='string'||!/^pay_[a-f0-9]{32}$/u.test(data.out_trade_no))return reply.code(200).send('failure');
        const row=await store.get('SELECT * FROM payment_orders WHERE id=?',data.out_trade_no);
        if(!row)return reply.code(200).send('failure');
        const receipt=payment.verifyNotify(data,row);
        await settle(row.id,receipt);
        return reply.code(200).send('success');
      }catch{return reply.code(200).send('failure');}
    });
  });
}
