import {createHmac,randomInt,timingSafeEqual,randomUUID} from 'node:crypto';
import {ApiError,sha256,phoneNumber} from './security.js';

const purposes=new Set(['registration','password_reset']);
const recoveryUnavailable=()=>new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');

export class SmsService {
  constructor(store,{transport=null,hmacKey=null,limits=true,now=Date.now,provider='local',issuer=null}={}) {
    Object.assign(this,{store,transport,hmacKey,limits,now,provider,issuer});
    store.run("UPDATE sms_challenges SET state='superseded',attempt_nonce=NULL WHERE used_at IS NULL AND state IN ('sent','sending','verifying') AND (provider<>? OR COALESCE(issuer,'')<>?)",provider,issuer||'');
  }
  context(options={}) {
    const purpose=options.purpose||'registration';
    if(!purposes.has(purpose))throw new ApiError(400,'INVALID_REQUEST','验证码用途无效');
    return {purpose,targetUserId:options.user?.id||options.targetUserId||null,user:options.user||null};
  }
  canRecover(user) {
    return !!(this.transport&&this.hmacKey&&Buffer.byteLength(this.hmacKey)>=32&&user&&!user.disabled&&user.phone_verified&&user.phone_number);
  }
  digest(challenge,phone,code){return createHmac('sha256',this.hmacKey).update(`${challenge}\n${phone}\n${code}`).digest('hex');}
  async challenge(raw,ip,options={}) {
    const phone=phoneNumber(raw),now=this.now(),ipHash=sha256(ip||'unknown'),context=this.context(options);
    if(!this.transport||!this.hmacKey||Buffer.byteLength(this.hmacKey)<32)throw new ApiError(503,'SMS_NOT_CONFIGURED','短信验证尚未配置');
    this.checkSend(phone,ipHash,now,context);
    const challengeId=`sms_${randomUUID()}`,code=String(randomInt(0,1000000)).padStart(6,'0'),expires=now+300000;
    this.store.run('INSERT INTO sms_challenges(id,phone,code_hmac,expires_at,created_at,ip_hash,state,purpose,target_user_id) VALUES(?,?,?,?,?,?,?,?,?)',challengeId,phone,this.digest(challengeId,phone,code),expires,now,ipHash,'sending',context.purpose,context.targetUserId);
    try {await this.transport.send({phone,code,expiresInMinutes:5});this.store.run("UPDATE sms_challenges SET state='sent' WHERE id=?",challengeId);}
    catch {this.store.run("UPDATE sms_challenges SET state='failed' WHERE id=?",challengeId);throw new ApiError(503,'SMS_UNAVAILABLE','短信暂不可用，请稍后重试');}
    return {challengeId,expiresAt:new Date(expires).toISOString(),retryAfterSeconds:60};
  }
  checkSend(phone,ipHash,now,context) {
    const existing=this.store.get('SELECT * FROM users WHERE phone_number=?',phone);
    if(context.purpose==='registration'){
      if(existing)throw new ApiError(409,'VERSION_CONFLICT','手机号已注册，请登录');
    }else{
      if(!existing||existing.id!==context.targetUserId)throw recoveryUnavailable();
      if(existing.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
      if(!this.canRecover(existing))throw recoveryUnavailable();
    }
    if(this.limits){
      const rows=this.store.all('SELECT created_at FROM sms_challenges WHERE phone=? AND created_at>?',phone,now-86400000);
      if(rows.some(r=>r.created_at>now-60000)||rows.filter(r=>r.created_at>now-3600000).length>=5||rows.length>=10)throw new ApiError(429,'RATE_LIMITED','验证码发送过于频繁');
      const ipCount=this.store.get('SELECT COUNT(*) AS n FROM sms_challenges WHERE ip_hash=? AND created_at>?',ipHash,now-3600000).n;
      const globalCount=this.store.get('SELECT COUNT(*) AS n FROM sms_challenges WHERE created_at>?',now-3600000).n;
      if(ipCount>=20||globalCount>=100)throw new ApiError(429,'RATE_LIMITED','短信发送预算已用完，请稍后重试');
    }
  }
  verify(challengeId,phone,code,options={}) {
    if(!this.transport||!this.hmacKey)throw new ApiError(503,'SMS_NOT_CONFIGURED','短信验证尚未配置');
    const context=this.context(options),now=this.now();
    const row=this.store.get("SELECT * FROM sms_challenges WHERE id=? AND phone=? AND purpose=? AND COALESCE(target_user_id,'')=?",challengeId,phone,context.purpose,context.targetUserId||'');
    const failures=this.store.get('SELECT COUNT(*) AS n FROM sms_failures WHERE phone=? AND created_at>?',phone,now-1800000).n;
    if(!row||row.provider!=='local'||row.state!=='sent'||row.used_at||row.expires_at<=now||row.attempts>=5||failures>=5||typeof code!=='string'||!/^\d{6}$/u.test(code))throw new ApiError(422,'VALIDATION_FAILED','验证码无效、已使用或过期');
    const actual=Buffer.from(this.digest(challengeId,phone,code),'hex'),expected=Buffer.from(row.code_hmac,'hex');
    if(!timingSafeEqual(actual,expected)){
      this.store.run('UPDATE sms_challenges SET attempts=attempts+1 WHERE id=?',row.id);this.store.run('INSERT INTO sms_failures(phone,created_at) VALUES(?,?)',phone,now);
      throw new ApiError(422,'VALIDATION_FAILED','验证码无效、已使用或过期');
    }
    return row;
  }
  consumePrepared(proof,userId) {
    const options={purpose:proof.purpose,targetUserId:proof.targetUserId};
    const row=this.verify(proof.challengeId,proof.phone,proof.code,options);
    if(row.purpose==='password_reset'&&row.target_user_id!==userId)throw recoveryUnavailable();
    const changed=this.store.run("UPDATE sms_challenges SET state='consumed',used_at=? WHERE id=? AND used_at IS NULL AND purpose=? AND COALESCE(target_user_id,'')=?",this.now(),row.id,row.purpose,row.target_user_id||'').changes;
    if(changed!==1)throw new ApiError(422,'VALIDATION_FAILED','验证码无效、已使用或过期');
  }
  prepare(challengeId,phone,code,options={}) {
    const context=this.context(options);this.verify(challengeId,phone,code,context);
    return {challengeId,phone,code,purpose:context.purpose,targetUserId:context.targetUserId};
  }
  release(){}
}
