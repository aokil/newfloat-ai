import {createClient} from '@supabase/supabase-js';
import {randomUUID} from 'node:crypto';
import {isIP} from 'node:net';
import {ApiError,phoneNumber} from './security.js';

const unavailable=()=>new ApiError(503,'SMS_UNAVAILABLE','短信验证暂不可用，请重新获取验证码');
const invalid=()=>new ApiError(422,'VALIDATION_FAILED','验证码无效或过期');
function providerPhone(value){
  if(typeof value!=='string'||!/^(?:\+?86)?1[3-9]\d{9}$/u.test(value))throw unavailable();
  return phoneNumber(value.replace(/^\+?86/u,''));
}

/** Only server-selected configuration is accepted. No browser configuration route. */
export function configuredSupabasePhone(env=process.env,options={}) {
  if(env.SMS_PROVIDER!=='supabase')return null;
  const raw=env.SUPABASE_URL,key=env.SUPABASE_PUBLISHABLE_KEY||env.SUPABASE_ANON_KEY;
  try {
    if(typeof raw!=='string'||typeof key!=='string'||/[\r\n\s]/u.test(key)||key.length>4096)return null;
    const url=new URL(raw);
    if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!['','/'].includes(url.pathname)||url.port||
      !url.hostname.includes('.')||isIP(url.hostname.replace(/^\[|\]$/gu,''))||/\.(localhost|local|internal)$/iu.test(url.hostname))return null;
    // Legacy JWT inspection rejects privileged config keys; it is NOT used for user authorization.
    const publishable=/^sb_publishable_[A-Za-z0-9_-]{16,}$/u.test(key);
    const parts=key.split('.');
    const legacy=parts.length===3&&JSON.parse(Buffer.from(parts[1],'base64url').toString('utf8')).role==='anon';
    if(!publishable&&!legacy)return null;
    return new SupabasePhoneVerifier(url.origin,key,options);
  } catch {return null;}
}

class SupabasePhoneVerifier {
  constructor(origin,key,{fetch:fetchImpl=globalThis.fetch,timeoutMs=8000}={}) {
    Object.assign(this,{origin,key,fetchImpl,timeoutMs});this.issuer=origin+'/auth/v1';this.provider='supabase';
  }
  client() {
    const deadline=AbortSignal.timeout(this.timeoutMs);
    const seen=new Set();
    const boundedFetch=async(input,init={})=>{
      const url=new URL(typeof input==='string'?input:input.url||String(input));
      const operation=`${init.method||'GET'} ${url.pathname}`;
      if(url.origin!==this.origin||url.search||url.hash||!['POST /auth/v1/otp','POST /auth/v1/verify','GET /auth/v1/user'].includes(operation)||seen.has(operation))throw unavailable();
      seen.add(operation); // Even if the SDK changes, a failed operation cannot be automatically repeated.
      const signal=init.signal?AbortSignal.any([deadline,init.signal]):deadline;
      const response=await this.fetchImpl(url.href,{...init,redirect:'error',signal});
      if(response.status>=300&&response.status<400||response.redirected||response.url&&new URL(response.url).origin!==this.origin)throw unavailable();
      const reader=response.body?.getReader();const chunks=[];let size=0;
      try {
        if(reader)for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>65536)throw unavailable();chunks.push(value);}
      } finally {await reader?.cancel().catch(()=>{});}
      return new Response(Buffer.concat(chunks),{status:response.status,headers:response.headers});
    };
    return createClient(this.origin,this.key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false,
      storageKey:`phone-proof-${randomUUID()}`},global:{fetch:boundedFetch}});
  }
  async send({phone,createUser=true}) {
    const client=this.client();
    try {
      const {error}=await client.auth.signInWithOtp({phone:phoneNumber(phone),options:{channel:'sms',shouldCreateUser:createUser}});
      if(error)throw unavailable();
    }catch {throw unavailable();}finally {await client.auth.dispose();}
  }
  async verify({phone,code}) {
    const client=this.client();phone=phoneNumber(phone);
    try {
      const {data,error}=await client.auth.verifyOtp({phone,token:code,type:'sms'});
      if(error){if(error.code==='otp_expired'||error.status===400&&error.code==='validation_failed')throw invalid();throw unavailable();}
      const token=data?.session?.access_token;
      if(typeof token!=='string'||!token||token.length>16384||!data.user?.id)throw unavailable();
      // Query the pinned Auth server; never authorize using decoded client JWTs or user_metadata.
      const result=await client.auth.getUser(token);const user=result.data?.user;
      if(result.error||!user||user.id!==data.user.id||!/^[-a-zA-Z0-9_]{1,128}$/u.test(user.id)||
        providerPhone(user.phone)!==phone||typeof user.phone_confirmed_at!=='string'||
        !Number.isFinite(Date.parse(user.phone_confirmed_at))||user.is_anonymous===true)throw unavailable();
      return Object.freeze({issuer:this.issuer,subject:user.id,phone});
    }catch(error){if(error instanceof ApiError)throw error;throw unavailable();}finally {await client.auth.dispose();}
  }
}
