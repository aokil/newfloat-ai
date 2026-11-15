import {ApiError,fields,sha256} from './security.js';
import {ExternalPhoneService} from './external-phone.js';

const providers=Object.freeze({supabase:'原短信通道（Supabase）',aliyun_pnvs:'阿里云短信认证'});
const unavailable=()=>new ApiError(503,'SMS_UNAVAILABLE','短信验证暂不可用，请重新获取验证码');

/** Credentials are frozen at startup; only the selected provider is shared through the database. */
export class PhoneProviderService {
  constructor(store,{verifiers,environment,defaultProvider='supabase',limits=true,allowVerifiedPhoneRecovery=false}) {
    if(!['DEV','PROD'].includes(environment)||!Object.hasOwn(providers,defaultProvider))throw Error('PHONE_PROVIDER_CONFIGURATION_INVALID');
    this.store=store;this.environment=environment;this.defaultProvider=defaultProvider;this.proofs=new WeakMap();
    this.services=new Map(Object.keys(providers).map(name=>[name,verifiers[name]
      ?new ExternalPhoneService(store,{verifier:verifiers[name],limits,allowVerifiedPhoneRecovery}):null]));
  }
  async initialize() {
    // Initializing either service must not invalidate the other provider's live challenges.
    for(const service of this.services.values())if(service)await service.initialize({preserveOtherProviders:true});
  }
  async selection() {
    const row=await this.store.get('SELECT * FROM phone_provider_settings WHERE environment=?',this.environment);
    return row||{provider:this.defaultProvider,revision:0,updated_at:null};
  }
  async status() {
    const selected=await this.selection();
    return {provider:selected.provider,revision:selected.revision,ready:Boolean(this.services.get(selected.provider)),
      updatedAt:selected.updated_at===null?null:new Date(selected.updated_at).toISOString(),
      providers:Object.entries(providers).map(([provider,displayName])=>({provider,displayName,configured:Boolean(this.services.get(provider))}))};
  }
  async active() {
    const selected=await this.selection(),service=this.services.get(selected.provider);
    if(!service)throw unavailable();return service;
  }
  async canRecover(user) {
    const selected=await this.selection(),service=this.services.get(selected.provider);
    return service?service.canRecover(user):false;
  }
  async challenge(...args) {return (await this.active()).challenge(...args);}
  async prepare(challengeId,...args) {
    // A code already sent stays bound to its original provider even after an administrator switches.
    const row=await this.store.get('SELECT provider,issuer FROM sms_challenges WHERE id=?',challengeId);
    const service=row&&this.services.get(row.provider);
    if(!service||service.verifier.issuer!==row.issuer)throw unavailable();
    const proof=await service.prepare(challengeId,...args);this.proofs.set(proof,service);return proof;
  }
  async consumePrepared(proof,userId) {
    const service=this.proofs.get(proof);if(!service)throw unavailable();
    return service.consumePrepared(proof,userId);
  }
  async release(proof) {
    const service=proof&&this.proofs.get(proof);if(!service)return;
    this.proofs.delete(proof);return service.release(proof);
  }
  async select(provider,expectedRevision,actor) {
    const old=await this.selection();
    if(old.revision!==expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','短信通道已更新，请刷新后重试');
    if(!this.services.get(provider))throw new ApiError(422,'VALIDATION_FAILED','该短信通道尚未配置完成');
    if(old.provider===provider)return this.status();
    const now=Date.now();
    if(old.revision===0)await this.store.run('INSERT INTO phone_provider_settings(environment,provider,revision,updated_at,updated_by) VALUES(?,?,?,?,?)',this.environment,provider,1,now,actor);
    else await this.store.run('UPDATE phone_provider_settings SET provider=?,revision=revision+1,updated_at=?,updated_by=? WHERE environment=? AND revision=?',provider,now,actor,this.environment,expectedRevision);
    await this.store.audit(actor,'switch-phone-provider',this.environment,{from:old.provider,to:provider,revision:old.revision+1});
    return this.status();
  }
}

export function phoneProviderRoutes(app,{service,admin,idem}) {
  app.get('/v1/admin/phone-provider',{preHandler:admin},async()=>service?service.status():{
    provider:null,revision:0,ready:false,updatedAt:null,
    providers:Object.entries(providers).map(([provider,displayName])=>({provider,displayName,configured:false}))});
  app.put('/v1/admin/phone-provider',{preHandler:admin},async req=>{
    fields(req.body,['provider','expectedRevision']);
    if(typeof req.body.provider!=='string'||!Object.hasOwn(providers,req.body.provider)||!Number.isSafeInteger(req.body.expectedRevision)||req.body.expectedRevision<0)
      throw new ApiError(400,'INVALID_REQUEST','短信通道或版本无效');
    if(!service)throw unavailable();
    return idem(req,sha256(JSON.stringify(req.body)),()=>service.select(req.body.provider,req.body.expectedRevision,req.auth.user_id));
  });
}
