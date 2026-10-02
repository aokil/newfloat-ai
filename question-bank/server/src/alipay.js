import {createPrivateKey,createPublicKey} from 'node:crypto';
import {debuglog} from 'node:util';
import {AlipaySdk} from 'alipay-sdk';

// Prices are the product owner's confirmed offers. The client sends only an ID.
export const POINTS_PACKAGES=Object.freeze([
  Object.freeze({id:'points-100',title:'100 点套餐',amountMinor:990,points:100}),
  Object.freeze({id:'points-300',title:'300 点套餐',amountMinor:1990,points:300}),
  Object.freeze({id:'points-600',title:'600 点套餐',amountMinor:2990,points:600})
]);
const ENDPOINTS=Object.freeze({production:'https://openapi.alipay.com',sandbox:'https://openapi-sandbox.dl.alipaydev.com'});
const ORDER_PATTERN=/^pay_[a-f0-9]{32}$/u;
const TRADE_PATTERN=/^[A-Za-z0-9_]{1,64}$/u;
const PAID_STATUSES=new Set(['TRADE_SUCCESS','TRADE_FINISHED']);
export class AlipayFailure extends Error {
  constructor(code){super(code);this.code=code;}
}
export function amountInMinor(value){
  if(typeof value!=='string'||!/^\d{1,9}(?:\.\d{1,2})?$/u.test(value))throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
  const [whole,fraction='']=value.split('.'),result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)||result<1)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
  return result;
}
export function amountString(value){
  if(!Number.isSafeInteger(value)||value<1)throw new AlipayFailure('PAYMENT_INVALID_AMOUNT');
  return `${Math.floor(value/100)}.${String(value%100).padStart(2,'0')}`;
}
function configurationValue(env,name){return typeof env[name]==='string'?env[name].trim():'';}
function unsafeDebug(value){
  return String(value||'').split(/[,\s]+/u).filter(Boolean).some(token=>{
    const pattern=token.replace(/[|\\{}()[\]^$+?.]/gu,'\\$&').replace(/\*/gu,'.*');
    const match=new RegExp(`^${pattern}$`,'iu');
    return match.test('alipay-sdk')||match.test('alipay-sdk:util');
  });
}
function pem(value,label){
  if(!value||value.length>16384)throw new AlipayFailure('PAYMENT_KEY_INVALID');
  if(value.startsWith('-----BEGIN '))return value;
  if(!/^[A-Za-z0-9+/=\s]+$/u.test(value))throw new AlipayFailure('PAYMENT_KEY_INVALID');
  return `-----BEGIN ${label}-----\n${value.replace(/\s/gu,'')}\n-----END ${label}-----`;
}
function unavailable(reason){return Object.freeze({ready:false,unavailableReason:reason,environment:null,appId:null,sellerId:null});}
function providerError(error){
  const code=error&&typeof error==='object'&&typeof error.code==='string'?error.code:'';
  if(code==='ACQ.TRADE_NOT_EXIST')return new AlipayFailure('PAYMENT_TRADE_NOT_FOUND');
  if(['ACQ.INVALID_PARAMETER','ACQ.ACCESS_FORBIDDEN','ACQ.INVALID_APP_ID','isv.app-not-exist','isv.insufficient-isv-permissions'].includes(code))
    return new AlipayFailure('PAYMENT_PROVIDER_REJECTED');
  if(code==='response-signature-verify-error'||code==='response-alipay-sn-verify-error')return new AlipayFailure('PAYMENT_INVALID_RECEIPT');
  return new AlipayFailure('PAYMENT_PROVIDER_UNAVAILABLE');
}
function object(value){return value!==null&&typeof value==='object'&&!Array.isArray(value);}
function qrCode(value){
  if(typeof value!=='string'||value.length>2048)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
  let url;try{url=new URL(value);}catch{throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');}
  if(url.protocol!=='https:'||url.hostname!=='qr.alipay.com'||url.port||url.username||url.password||url.hash)
    throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
  return value;
}

/** Server-only configuration. No key, SDK object or raw upstream response escapes. */
export function configuredAlipayTransport(env=process.env){
  if(env.ALIPAY_ENABLED!=='true')return unavailable('PAYMENT_NOT_OPEN');
  const environment=configurationValue(env,'ALIPAY_ENVIRONMENT');
  if(!Object.hasOwn(ENDPOINTS,environment))return unavailable('PAYMENT_ENVIRONMENT_NOT_CONFIGURED');
  // Preview must never use live credentials or create a production charge.
  if((env.COZE_PROJECT_ENV==='DEV'&&environment!=='sandbox')||(env.COZE_PROJECT_ENV==='PROD'&&environment!=='production'))
    return unavailable('PAYMENT_ENVIRONMENT_MISMATCH');
  const appId=configurationValue(env,'ALIPAY_APP_ID'),sellerId=configurationValue(env,'ALIPAY_SELLER_ID');
  if(!/^\d{16}$/u.test(appId)||!/^2088\d{12}$/u.test(sellerId))return unavailable('PAYMENT_MERCHANT_NOT_CONFIGURED');
  let notifyUrl;
  try{
    notifyUrl=new URL(configurationValue(env,'ALIPAY_NOTIFY_URL'));
    if(notifyUrl.protocol!=='https:'||notifyUrl.username||notifyUrl.password||notifyUrl.port||notifyUrl.search||notifyUrl.hash||
      notifyUrl.pathname!=='/v1/payments/alipay/notify')throw new Error('invalid');
    if(env.COZE_PROJECT_ENV==='PROD'&&notifyUrl.origin!=='https://d635c6m6jj.coze.site')throw new Error('invalid');
    if(env.COZE_PROJECT_ENV==='DEV'&&notifyUrl.origin!=='https://cf9706dd-b534-450f-abf6-39b2858e5836.dev.coze.site')throw new Error('invalid');
  }catch{return unavailable('PAYMENT_NOTIFY_NOT_CONFIGURED');}
  // Debug output from the official SDK can contain signed requests and account data.
  if(unsafeDebug(env.NODE_DEBUG)||debuglog('alipay-sdk').enabled||debuglog('alipay-sdk:util').enabled)
    return unavailable('PAYMENT_UNSAFE_DEBUG_CONFIGURATION');
  let sdk;
  try{
    const privateKey=pem(configurationValue(env,'ALIPAY_APP_PRIVATE_KEY'),'PRIVATE KEY');
    const publicKey=pem(configurationValue(env,'ALIPAY_PUBLIC_KEY'),'PUBLIC KEY');
    const privateObject=createPrivateKey({key:privateKey,type:'pkcs8',format:'pem'}),publicObject=createPublicKey(publicKey);
    if(privateObject.asymmetricKeyType!=='rsa'||publicObject.asymmetricKeyType!=='rsa'||
      privateObject.asymmetricKeyDetails?.modulusLength<2048||publicObject.asymmetricKeyDetails?.modulusLength<2048)
      return unavailable('PAYMENT_KEY_INVALID');
    sdk=new AlipaySdk({appId,privateKey,alipayPublicKey:publicKey,keyType:'PKCS8',signType:'RSA2',
      endpoint:ENDPOINTS[environment],gateway:`${ENDPOINTS[environment]}/gateway.do`,timeout:8000});
  }catch{return unavailable('PAYMENT_KEY_INVALID');}
  let active=0;
  async function call(path,body){
    if(active>=4)throw new AlipayFailure('PAYMENT_PROVIDER_BUSY');
    active++;
    try{
      // curl verifies the signed API v3 response by default. Never use curlStream.
      const response=await sdk.curl('POST',path,{body,requestTimeout:8000});
      if(response.responseHttpStatus!==200||!object(response.data))throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      return response.data;
    }catch(error){if(error instanceof AlipayFailure)throw error;throw providerError(error);}
    finally{active--;}
  }
  function sameContext(order){
    if(!order||!ORDER_PATTERN.test(order.id)||order.environment!==environment||order.app_id!==appId||order.seller_id!==sellerId)
      throw new AlipayFailure('PAYMENT_CONTEXT_MISMATCH');
  }
  function receipt(data,order,source){
    if(!object(data)||data.out_trade_no!==order.id||!TRADE_PATTERN.test(data.trade_no||'')||
      !['WAIT_BUYER_PAY','TRADE_CLOSED','TRADE_SUCCESS','TRADE_FINISHED'].includes(data.trade_status)||
      amountInMinor(data.total_amount)!==order.amount_minor)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
    return {orderId:order.id,tradeNo:data.trade_no,status:data.trade_status,amountMinor:order.amount_minor,
      appId,sellerId,environment,verified:true,source,paid:PAID_STATUSES.has(data.trade_status)};
  }
  return Object.freeze({ready:true,unavailableReason:null,environment,appId,sellerId,
    async precreate(order){
      sameContext(order);
      if(!Number.isSafeInteger(order.expires_at)||order.expires_at<=Date.now())throw new AlipayFailure('PAYMENT_ORDER_EXPIRED');
      // Alipay expects Beijing time. Retries retain the original absolute
      // deadline and merchant order number; they cannot extend payment time.
      const expires=new Date(order.expires_at+8*60*60*1000).toISOString().slice(0,19).replace('T',' ');
      const data=await call('/v3/alipay/trade/precreate',{out_trade_no:order.id,seller_id:sellerId,
        total_amount:amountString(order.amount_minor),subject:`FLOAT AI · ${order.package_title}`,
        notify_url:notifyUrl.href,time_expire:expires});
      if(data.out_trade_no!==order.id)throw new AlipayFailure('PAYMENT_INVALID_RECEIPT');
      return {orderId:order.id,qrCode:qrCode(data.qr_code),verified:true};
    },
    async query(order){
      sameContext(order);
      const data=await call('/v3/alipay/trade/query',{out_trade_no:order.id});
      // Query responses do not contain app_id/seller_id. The signed fixed SDK
      // context is checked against the immutable context that created this order.
      return receipt(data,order,'query');
    },
    verifyNotify(data,order){
      sameContext(order);
      if(!object(data)||data.sign_type!=='RSA2'||typeof data.sign!=='string'||data.sign.length>1024||
        data.app_id!==appId||data.seller_id!==sellerId||data.notify_type!=='trade_status_sync')
        throw new AlipayFailure('PAYMENT_INVALID_NOTIFY');
      let verified=false;try{verified=sdk.checkNotifySignV2(data);}catch{}
      if(!verified)throw new AlipayFailure('PAYMENT_INVALID_NOTIFY');
      return receipt(data,order,'notify');
    }
  });
}
