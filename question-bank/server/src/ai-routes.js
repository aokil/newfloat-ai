import {ApiError,authenticate,fields,id,sha256,text} from './security.js';
import {points,requirePositivePoints} from './account.js';
import {BYOK_PROVIDERS,byokConfiguration,officialModelSearch,openKey} from './models.js';
import {MODEL_CATALOG,catalogEntry,configuredCatalog,modelUnavailableReason} from './model-catalog.js';
import {minimalAnswer} from './answer-only.js';
import {validateAiImage,aiImageDigest,modelSupportsImages} from './ai-image.js';

const ERROR_MESSAGES={
  MODEL_REQUEST_INVALID:'模型请求格式不兼容，请更新配套后台后重试，本次未扣平台点数',
  MODEL_IMAGE_UNSUPPORTED:'当前模型不支持图片识别，无法直接发送图片',
  PROVIDER_AUTH_FAILED:'模型 API Key 无效，请检查配置',MODEL_FORBIDDEN:'当前 Key 没有该模型权限',
  PROVIDER_BALANCE_LOW:'模型服务商余额不足',PROVIDER_RATE_LIMITED:'模型服务商请求繁忙，请稍后重试',
  TIMEOUT_UNKNOWN:'模型响应超时，本次未扣平台点数',NETWORK_UNKNOWN:'模型连接失败，本次未扣平台点数',
  EMPTY_RESPONSE:'模型未返回有效答案，本次未扣平台点数',TRUNCATED_RESPONSE:'模型答案未生成完整，本次未扣平台点数',
  INCOMPLETE_RESPONSE:'模型未完成回答，本次未扣平台点数',USAGE_MISSING:'模型未返回完整调用凭据，本次未扣平台点数',
  INVALID_ANSWER:'模型答案格式无效，本次未扣平台点数',INVALID_PROVIDER_RESPONSE:'模型响应格式无效，本次未扣平台点数',
  PROVIDER_RESPONSE_TOO_LARGE:'模型响应超出处理范围，本次未扣平台点数',PROCESS_INTERRUPTED:'模型请求已中断，本次未扣平台点数',
  COZE_INTEGRATION_NOT_READY:'Coze 模型集成当前未就绪，本次未扣平台点数',
  COZE_MODEL_LIST_UNAVAILABLE:'Coze 模型目录当前不可用，本次未扣平台点数',
  COZE_MODEL_UNAVAILABLE:'所选 Coze 模型当前不可用，本次未扣平台点数',
  PROJECT_IDENTITY_UNAVAILABLE:'Coze 项目身份当前不可用，本次未扣平台点数'
};
const masterConfigured=value=>{try{return Buffer.from(value||'','base64').length===32;}catch{return false;}};
function keyUsable(binding,master){
  if(!binding)return false;
  if(binding.config.execution==='coze')return binding.bridgeReady===true;
  if(!masterConfigured(master))return false;
  try{const key=openKey(binding.row.encrypted_key,master);return typeof key==='string'&&key.length>=8&&!/[\r\n]/u.test(key);}catch{return false;}
}
function providerError(error){
  if(error instanceof ApiError)return error;
  const code=Object.hasOwn(ERROR_MESSAGES,error?.message)?error.message:/^PROVIDER_HTTP_\d{3}$/u.test(error?.message||'')?error.message:'PROVIDER_FAILED';
  return new ApiError(code==='MODEL_IMAGE_UNSUPPORTED'?422:code==='PROVIDER_RATE_LIMITED'?429:['COZE_INTEGRATION_NOT_READY','COZE_MODEL_LIST_UNAVAILABLE','COZE_MODEL_UNAVAILABLE','PROJECT_IDENTITY_UNAVAILABLE'].includes(code)?503:502,code,ERROR_MESSAGES[code]||'模型调用失败，本次未扣平台点数');
}
async function releaseFailed(store,row,error){
  const fresh=await store.get('SELECT * FROM ai_requests WHERE id=?',row.id);
  if(fresh?.status!=='pending')return;
  if(fresh.points_cost>0)await store.run('UPDATE users SET points_reserved=points_reserved-?,revision=revision+1 WHERE id=?',fresh.points_cost,fresh.user_id);
  await store.run("UPDATE ai_requests SET status='failed',error_code=?,error_message=?,http_status=?,updated_at=? WHERE id=?",error.code,error.message,error.statusCode,Date.now(),fresh.id);
  await store.audit(fresh.user_id,'ai-search-failed',fresh.id,{errorCode:error.code,pointsCharged:0});
}
async function recoverExpired(store){
  for(const row of await store.all("SELECT * FROM ai_requests WHERE status='pending' AND expires_at<=?",Date.now())){
    await store.transaction(async()=>{
      const fresh=await store.get('SELECT * FROM ai_requests WHERE id=?',row.id);
      if(fresh?.status==='pending'&&fresh.expires_at<=Date.now())
        await releaseFailed(store,fresh,new ApiError(503,'PROCESS_INTERRUPTED',ERROR_MESSAGES.PROCESS_INTERRUPTED));
    });
  }
}
async function previousResult(store,row,digest){
  if(row.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','本次请求标识已用于其他问题、模型或Key');
  if(row.status==='pending')throw new ApiError(409,'AI_REQUEST_PENDING','模型仍在处理中，请使用同一请求标识稍后查询');
  if(row.status==='failed')throw new ApiError(row.http_status||502,row.error_code||'PROVIDER_FAILED',row.error_message||'此前请求失败，本次未再次调用模型');
  const user=await store.get('SELECT points_balance,points_reserved FROM users WHERE id=?',row.user_id);
  return {...JSON.parse(row.result),pointsAvailable:user.points_balance-user.points_reserved};
}
function validateReceipt(result,question){
  if(!result||typeof result.answer!=='string'||!result.answer.trim()||result.answer.length>16000||typeof result.explanation!=='string'||result.explanation.length>16000)throw new Error('INVALID_ANSWER');
  if(!result.usage||!['prompt_tokens','completion_tokens','total_tokens'].every(key=>Number.isSafeInteger(result.usage[key])&&result.usage[key]>=0))throw new Error('USAGE_MISSING');
  return {answer:minimalAnswer(result.answer,question),explanation:'',usage:{prompt_tokens:result.usage.prompt_tokens,completion_tokens:result.usage.completion_tokens,total_tokens:result.usage.total_tokens}};
}

export async function aiRoutes(app,{store,auth,modelMasterKey,aiTransport=officialModelSearch,cozeBridge=null,rateLimits=true}){
  await recoverExpired(store);
  let recoveryTask=null;
  const recovery=setInterval(()=>{
    if(recoveryTask)return;
    recoveryTask=recoverExpired(store).catch(()=>app.log.error({code:'AI_RECOVERY_FAILED'},'AI reservation recovery failed')).finally(()=>{recoveryTask=null;});
  },15000);
  recovery.unref();app.addHook('onClose',async()=>{clearInterval(recovery);if(recoveryTask)await recoveryTask;});

  app.get('/v1/models/catalog',{preHandler:auth},async req=>{
    const user=await store.get('SELECT * FROM users WHERE id=?',req.auth.user_id),available=user.points_balance-user.points_reserved,bindings=await configuredCatalog(store);
    let imageModels=null;
    if(cozeBridge?.ready&&[...bindings.values()].some(binding=>binding?.config.execution==='coze')){
      try{imageModels=(await cozeBridge.metadata()).items;}catch{}
    }
    const items=MODEL_CATALOG.map(item=>{
      const binding=bindings.get(item.key);
      const imageModel=imageModels?.find(model=>model.model_id===binding?.config.modelId);
      const supportsImages=!!binding&&(binding.config.execution!=='coze'||!!imageModel)&&modelSupportsImages(binding.config.modelId,imageModel?.input_types);
      const reason=modelUnavailableReason(item,binding)||(!keyUsable(binding,modelMasterKey)?'MODEL_KEY_NOT_CONFIGURED':null)||(available<item.pointsPerCall?'INSUFFICIENT_POINTS':null);
      return {...item,name:binding?.config.execution==='coze'?binding.config.displayName:item.name,configured:!!binding,available:!reason,unavailableReason:reason,
        supportsImages,capabilities:supportsImages?['text','image']:['text']};
    });
    return {items,byokProviders:BYOK_PROVIDERS,pointsAvailable:available,policy:{basicRequiresPositivePoints:true,basicPointsPerUse:0,byokPointsPerCall:0}};
  });

  // Read a durable receipt after a disconnected response or a client restart.
  // Authentication still applies, but neither a new Key nor positive points is required.
  app.get('/v1/ai/receipt',{preHandler:auth},async req=>{
    const keyHash=sha256(text(req.headers['idempotency-key'],'Idempotency-Key',1,128));
    await recoverExpired(store);
    const row=await store.get('SELECT * FROM ai_requests WHERE user_id=? AND idempotency_hash=?',req.auth.user_id,keyHash);
    if(!row)throw new ApiError(404,'AI_REQUEST_NOT_FOUND','未找到本次模型请求的回执');
    return await previousResult(store,row,row.request_hash);
  });

  app.post('/v1/ai/search',{preHandler:auth,config:{rateLimit:rateLimits?{max:20,timeWindow:'1 minute'}:false}},async req=>{
    let personal=null,config,secret,model,request;
    try{
      fields(req.body,['mode','modelKey','question','byok','image']);
      const question=text(req.body.question,'question',1,16000).trim(),mode=req.body.mode;
      const image=req.body.image===undefined?null:validateAiImage(req.body.image);
      if(!['builtin','byok'].includes(mode))throw new ApiError(400,'INVALID_REQUEST','请选择内置模型或自带Key');
      if(mode==='builtin'&&req.body.byok!==undefined||mode==='byok'&&req.body.modelKey!==undefined)throw new ApiError(400,'INVALID_REQUEST','模型配置不能混用');
      const keyHash=sha256(text(req.headers['idempotency-key'],'Idempotency-Key',1,128));
      personal=mode==='byok'?byokConfiguration(req.body.byok):null;
      const product=mode==='builtin'?catalogEntry(text(req.body.modelKey,'modelKey',1,64)):null;
      if(mode==='builtin'&&!product)throw new ApiError(400,'INVALID_REQUEST','请选择目录中的模型');
      // Persist a request digest, never the request body or API Key.
      const digest=sha256(JSON.stringify({mode,modelKey:product?.key??null,question,
        ...(image?{image:{mimeType:image.mimeType,sha256:aiImageDigest(image)}}:{}),
        byok:personal?{provider:personal.provider,baseUrl:personal.baseUrl,modelId:personal.modelId,keyHash:sha256(personal.apiKey)}:null}));
      let imageModels=null;
      if(image&&cozeBridge?.ready){try{imageModels=(await cozeBridge.metadata()).items;}catch{}}
      await recoverExpired(store);
      const begin=await store.transaction(async()=>{
        req.auth=await authenticate(store,req);
        const prior=await store.get('SELECT * FROM ai_requests WHERE user_id=? AND idempotency_hash=?',req.auth.user_id,keyHash);
        if(prior)return {replay:await previousResult(store,prior,digest)};
        const user=await requirePositivePoints(store,req.auth.user_id),now=Date.now();
        if((await store.get("SELECT COUNT(*) AS n FROM ai_requests WHERE user_id=? AND status='pending'",user.id)).n>=3)throw new ApiError(429,'RATE_LIMITED','已有多个模型请求处理中，请稍后重试');
        let row=null,cost=0;
        if(mode==='builtin'){
          const binding=(await configuredCatalog(store)).get(product.key),reason=modelUnavailableReason(product,binding);
          if(reason||!keyUsable(binding,modelMasterKey))throw new ApiError(503,'MODEL_UNAVAILABLE','该内置模型尚未配置、验证或启用，请选择其他模型');
          row=binding.row;config=binding.config;cost=product.pointsPerCall;
          const imageModel=imageModels?.find(model=>model.model_id===config.modelId);
          if(image&&((config.execution==='coze'&&!imageModel)||!modelSupportsImages(config.modelId,imageModel?.input_types)))
            throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','当前模型不支持图片识别，无法直接发送图片');
          if(user.points_balance-user.points_reserved<cost)throw new ApiError(402,'INSUFFICIENT_POINTS',`该模型每次需要${cost}点，可用点数不足`);
          // Paid searches are governed by the points ledger, not a daily counter.
          // Legacy dailyRequestLimit values remain stored but are no longer enforced.
          if(config.execution==='coze')secret=null;
          else try{secret=openKey(row.encrypted_key,modelMasterKey);}catch{throw new ApiError(503,'MODEL_UNAVAILABLE','该模型密钥当前不可用，请联系管理员');}
          model={key:product.key,name:config.execution==='coze'?config.displayName:product.name,provider:product.provider,mode};
        }else{
          const {apiKey,...publicConfig}=personal;secret=apiKey;config=publicConfig;
          if(image&&!modelSupportsImages(config.modelId))throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','当前模型不支持图片识别，无法直接发送图片');
          model={key:`byok-${config.provider}`,name:config.modelId,provider:config.provider,mode};
        }
        const requestId=id('ai');
        if(cost>0)await store.run('UPDATE users SET points_reserved=points_reserved+?,revision=revision+1 WHERE id=?',cost,user.id);
        await store.run("INSERT INTO ai_requests(id,user_id,session_id,idempotency_hash,request_hash,mode,model_id,model_revision,catalog_key,points_cost,status,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)",
          requestId,user.id,req.auth.id,keyHash,digest,mode,row?.id??null,row?.revision??null,product?.key??null,cost,now,now,now+config.timeoutMs+15000);
        return {request:await store.get('SELECT * FROM ai_requests WHERE id=?',requestId)};
      });
      if(begin.replay)return begin.replay;
      request=begin.request;
      const receipt=validateReceipt(await (config.execution==='coze'?cozeBridge.search(config,question,{requestId:request.id,...(image?{image}:{})}):aiTransport(config,secret,question,image)),question);
      if(typeof secret==='string'&&secret&&(receipt.answer.includes(secret)||receipt.explanation.includes(secret)))throw new Error('INVALID_PROVIDER_RESPONSE');
      return await store.transaction(async()=>{
        const row=await store.get('SELECT * FROM ai_requests WHERE id=?',request.id);
        if(row.status!=='pending')return await previousResult(store,row,digest);
        if(row.expires_at<=Date.now())throw new ApiError(503,'PROCESS_INTERRUPTED',ERROR_MESSAGES.PROCESS_INTERRUPTED);
        // Token rotation during the request is fine; logout, password reset and
        // administrative revocation are not. Check the same session ID again.
        const session=await store.get('SELECT * FROM sessions WHERE id=?',row.session_id);
        if(!session||session.revoked||session.refresh_expires<=Date.now())throw new ApiError(401,'SESSION_REVOKED','登录已失效，本次未扣平台点数');
        let user=await store.get('SELECT * FROM users WHERE id=?',row.user_id);
        if(!user||user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号已停用，本次未扣平台点数');
        if(mode==='builtin'){
          const current=(await configuredCatalog(store)).get(product.key);
          if(!current||current.row.id!==row.model_id||current.row.revision!==row.model_revision||modelUnavailableReason(product,current))throw new ApiError(409,'MODEL_CHANGED','模型配置已变化，本次未扣平台点数');
        }else await requirePositivePoints(store,row.user_id);
        if(row.points_cost>0){
          await store.run('UPDATE users SET points_reserved=points_reserved-?,revision=revision+1 WHERE id=?',row.points_cost,row.user_id);
          user=await store.get('SELECT * FROM users WHERE id=?',row.user_id);
          await points(store,user,-row.points_cost,row.user_id,`AI搜题：${model.name}`,`ai-search:${row.id}`);
        }
        user=await store.get('SELECT * FROM users WHERE id=?',row.user_id);
        const result={requestId:row.id,status:'completed',source:'ai',model,...receipt,pointsCharged:row.points_cost,pointsAvailable:user.points_balance-user.points_reserved,
          ...(image?{inputMode:'image'}:{})};
        await store.run("UPDATE ai_requests SET status='completed',result=?,updated_at=? WHERE id=?",JSON.stringify(result),Date.now(),row.id);
        await store.audit(row.user_id,'ai-search-completed',row.id,{modelKey:row.catalog_key,mode,pointsCharged:row.points_cost});
        return result;
      });
    }catch(error){
      const safe=providerError(error);
      if(request)await store.transaction(async()=>await releaseFailed(store,request,safe));
      throw safe;
    }finally{
      secret=null;
      if(personal)personal.apiKey='';personal=null;
      if(req.body?.byok&&typeof req.body.byok==='object')req.body.byok.apiKey='';
      if(req.body?.image&&typeof req.body.image==='object')req.body.image.data='';
    }
  });
}
