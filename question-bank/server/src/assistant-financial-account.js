import {ApiError,sha256} from './security.js';
import {ASSISTANT_NANOS_PER_CENTIPOINT} from './assistant-token-prices.js';

// Preserve the existing language account/keyspace: media and language share one
// sub-centipoint carry and the same users.points_reserved balance.
const NAMESPACE='assistant_token_internal_v1:'+sha256('assistant-token-record-namespace')+':'+sha256('assistant-token-account-namespace')+':';
export const TOKEN_FINANCIAL_PREFIX=NAMESPACE+'request:';
export const MEDIA_FINANCIAL_PREFIX=NAMESPACE+'media:';
export const ASSISTANT_FINANCIAL_ACCOUNT=NAMESPACE+'account';
const ACCOUNT_TYPE='assistant_token_account_v1';
const types=new Set(['assistant_token_v1','assistant_media_billing_v1',ACCOUNT_TYPE]);
const validKey=key=>typeof key==='string'&&(key.startsWith(TOKEN_FINANCIAL_PREFIX)||key.startsWith(MEDIA_FINANCIAL_PREFIX));
const decode=row=>{
  try{
    const value=JSON.parse(row.result);
    if(value===null||typeof value!=='object'||!types.has(value.type))throw new Error('type');
    if(value.type===ACCOUNT_TYPE&&(!/^\d+$/u.test(value.carryNanos)||BigInt(value.carryNanos)>=ASSISTANT_NANOS_PER_CENTIPOINT||
      !Array.isArray(value.pending)||value.pending.some(key=>!validKey(key))||new Set(value.pending).size!==value.pending.length))throw new Error('account');
    return value;
  }catch{throw new ApiError(500,'ASSISTANT_BILLING_RECORD_INVALID','对话计费记录无法读取，未重复提交付费请求');}
};

/** Call mutating methods within store.transaction; never persist user content. */
export function assistantFinancialAccount(store){
  const read=async(owner,key)=>{
    const row=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
    return row?{row,value:decode(row)}:null;
  };
  const account=async owner=>{
    const existing=await read(owner,ASSISTANT_FINANCIAL_ACCOUNT);
    if(existing)return existing.value;
    const value={type:ACCOUNT_TYPE,carryNanos:'0',pending:[]};
    await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',
      owner,ASSISTANT_FINANCIAL_ACCOUNT,ASSISTANT_FINANCIAL_ACCOUNT,JSON.stringify(value));
    return value;
  };
  const write=async(owner,key,value)=>store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(value),owner,key);
  const getUser=async owner=>{
    const user=await store.get('SELECT * FROM users WHERE id=?',owner);
    if(!user)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    return user;
  };
  return {read,account,write,getUser};
}
