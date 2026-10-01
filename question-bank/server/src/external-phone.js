import {randomUUID} from 'node:crypto';
import {SmsService} from './sms.js';
import {ApiError,phoneNumber,sha256} from './security.js';

const invalid=()=>new ApiError(422,'VALIDATION_FAILED','验证码无效、已使用或过期，请重新获取');
const unavailable=()=>new ApiError(503,'SMS_UNAVAILABLE','短信验证结果不确定，请重新获取验证码');
const busy=()=>new ApiError(429,'RATE_LIMITED','手机号验证正在处理，请稍后重试');
const recoveryUnavailable=()=>new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');

/** External verification is asynchronous; only a one-request capability reaches the local transaction. */
export class ExternalPhoneService extends SmsService {
  constructor(store,{verifier,limits=true,now=Date.now}) {
    super(store,{limits,now,provider:verifier.provider,issuer:verifier.issuer});this.verifier=verifier;this.proofs=new WeakSet();
  }
  async initialize() {
    await super.initialize();
    // Other Coze instances may still own a live send/verification operation.
    // Only an expired challenge is safe to recover; uncertain OTPs are never replayed.
    await this.store.run("UPDATE sms_challenges SET state='uncertain',attempt_nonce=NULL WHERE provider<>'local' AND state IN ('sending','verifying') AND expires_at<=?",this.now());
  }
  async canRecover(user) {
    if(!user||user.disabled||!user.phone_verified||!user.phone_number)return false;
    return !!await this.store.get('SELECT 1 FROM external_phone_identities WHERE issuer=? AND user_id=? AND phone=?',this.verifier.issuer,user.id,user.phone_number);
  }
  async challenge(raw,ip,options={}) {
    const phone=phoneNumber(raw),now=this.now(),challengeId=`sms_${randomUUID()}`,expires=now+300000,context=this.context(options);
    await this.store.transaction(async()=>{
      await this.checkSend(phone,sha256(ip||'unknown'),now,context);
      if(await this.store.get("SELECT id FROM sms_challenges WHERE phone=? AND state IN ('sending','verifying') AND expires_at>?",phone,now))throw busy();
      // An upstream OTP belongs to a phone, so a new code supersedes every earlier local purpose.
      await this.store.run("UPDATE sms_challenges SET state='superseded' WHERE phone=? AND used_at IS NULL AND state='sent'",phone);
      await this.store.run('INSERT INTO sms_challenges(id,phone,code_hmac,expires_at,created_at,ip_hash,state,provider,issuer,purpose,target_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        challengeId,phone,'',expires,now,sha256(ip||'unknown'),'sending',this.verifier.provider,this.verifier.issuer,context.purpose,context.targetUserId);
    });
    try {
      await this.verifier.send({phone,createUser:context.purpose==='registration'});
      if(this.now()>=expires)throw unavailable();
      const changed=(await this.store.run("UPDATE sms_challenges SET state='sent' WHERE id=? AND state='sending'",challengeId)).changes;
      if(changed!==1)throw unavailable();
    }catch {
      await this.store.run("UPDATE sms_challenges SET state='uncertain' WHERE id=? AND state='sending'",challengeId);throw unavailable();
    }
    return {challengeId,expiresAt:new Date(expires).toISOString(),retryAfterSeconds:60};
  }
  async prepare(challengeId,phone,code,options={}) {
    const nonce=randomUUID(),context=this.context(options);
    await this.store.transaction(async()=>{
      const now=this.now(),row=await this.store.get("SELECT * FROM sms_challenges WHERE id=? AND phone=? AND purpose=? AND COALESCE(target_user_id,'')=?",challengeId,phone,context.purpose,context.targetUserId||'');
      if(!row||row.provider!==this.verifier.provider||row.issuer!==this.verifier.issuer||row.used_at||row.expires_at<=now)throw invalid();
      if(row.state==='verifying')throw busy();
      const failures=(await this.store.get('SELECT COUNT(*) AS n FROM sms_failures WHERE phone=? AND created_at>?',phone,now-1800000)).n;
      if(row.state!=='sent'||row.attempts>=5||failures>=5||typeof code!=='string'||!/^\d{6}$/u.test(code))throw invalid();
      await this.store.run("UPDATE sms_challenges SET state='verifying',attempt_nonce=?,attempts=attempts+1 WHERE id=?",nonce,challengeId);
    });
    try {
      const verified=await this.verifier.verify({phone,code});
      if(verified?.issuer!==this.verifier.issuer||verified.phone!==phone||typeof verified.subject!=='string'||!verified.subject||verified.subject.length>128)throw unavailable();
      const proof=Object.freeze({challengeId,phone,nonce,issuer:verified.issuer,subject:verified.subject,purpose:context.purpose,targetUserId:context.targetUserId});this.proofs.add(proof);return proof;
    }catch(error){
      await this.store.transaction(async()=>{
        await this.store.run("UPDATE sms_challenges SET state=?,attempt_nonce=NULL WHERE id=? AND state='verifying' AND attempt_nonce=?",error instanceof ApiError&&error.code==='VALIDATION_FAILED'?'sent':'uncertain',challengeId,nonce);
        await this.store.run('INSERT INTO sms_failures(phone,created_at) VALUES(?,?)',phone,this.now());
      });
      if(error instanceof ApiError&&error.code==='VALIDATION_FAILED')throw invalid();throw unavailable();
    }
  }
  async consumePrepared(proof,userId) {
    if(!this.proofs.has(proof))throw invalid();
    if(proof.purpose==='registration'){
      if(proof.targetUserId||await this.store.get('SELECT user_id FROM external_phone_identities WHERE issuer=? AND subject=?',proof.issuer,proof.subject))throw new ApiError(409,'VERSION_CONFLICT','外部手机号身份已绑定，请使用原账号登录');
    }else if(proof.purpose==='password_reset'){
      if(proof.targetUserId!==userId||!await this.store.get('SELECT 1 FROM external_phone_identities WHERE issuer=? AND subject=? AND user_id=? AND phone=?',proof.issuer,proof.subject,userId,proof.phone))throw recoveryUnavailable();
    }else throw invalid();
    const changed=(await this.store.run("UPDATE sms_challenges SET state='consumed',used_at=?,attempt_nonce=NULL WHERE id=? AND phone=? AND provider=? AND issuer=? AND purpose=? AND COALESCE(target_user_id,'')=? AND state='verifying' AND attempt_nonce=? AND used_at IS NULL AND expires_at>?",this.now(),proof.challengeId,proof.phone,this.verifier.provider,proof.issuer,proof.purpose,proof.targetUserId||'',proof.nonce,this.now())).changes;
    if(changed!==1)throw invalid();
    if(proof.purpose==='registration')await this.store.run('INSERT INTO external_phone_identities(issuer,subject,user_id,phone,verified_at) VALUES(?,?,?,?,?)',proof.issuer,proof.subject,userId,proof.phone,this.now());
  }
  async release(proof) {
    if(!proof)return;
    this.proofs.delete(proof);
    // If hashing or the local transaction fails after OTP consumption, require a fresh code.
    await this.store.run("UPDATE sms_challenges SET state='uncertain',attempt_nonce=NULL WHERE id=? AND state='verifying' AND attempt_nonce=?",proof.challengeId,proof.nonce);
  }
}
