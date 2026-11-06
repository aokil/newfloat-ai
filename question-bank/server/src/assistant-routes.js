import {ApiError,sha256} from './security.js';
import {MODEL_CATALOG,catalogEntry,configuredCatalog,modelUnavailableReason} from './model-catalog.js';
import {modelSecret} from './models.js';
import {modelSupportsImages} from './ai-image.js';
import {assistantRequest} from './assistant-protocol.js';
import {officialAssistantCompletion,assistantProviderBody} from './assistant-model-transport.js';
import {officialAssistantChat} from './assistant-model-transport.js';
import {assistantThinkingProfile} from './assistant-thinking.js';
import {assistantErrorDiagnostic,assistantBackendDiagnostic} from './assistant-provider-errors.js';
import {once} from 'node:events';
import {prepareCozeAssistant} from './assistant-json-planner.js';
import {assistantTokenPricing,assistantTokenReservation} from './assistant-token-prices.js';
import {assistantTokenBilling} from './assistant-token-billing.js';

// Display only provider numeric counters; arbitrary fields in an upstream usage object stay private.
const displayUsage=value=>{
  if(value===null||typeof value!=='object'||Array.isArray(value))return null;
  const output={};
  const number=(source,target,key)=>{if(Number.isSafeInteger(source[key])&&source[key]>=0)target[key]=source[key];};
  for(const key of ['prompt_tokens','completion_tokens','total_tokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','reasoning_tokens'])number(value,output,key);
  for(const name of ['prompt_tokens_details','completion_tokens_details']){
    const part=value[name];
    if(part!==null&&typeof part==='object'&&!Array.isArray(part)){
      const detail={};for(const key of ['cached_tokens','reasoning_tokens'])number(part,detail,key);
      if(Object.keys(detail).length)output[name]=detail;
    }
  }
  return Object.keys(output).length?output:null;
};

// Paid language-model requests only. Search, BYOK and media retain their separate rules.
export async function assistantRoutes(app,{store,auth,modelMasterKey,baichuanApiKey=null,deepseekApiKey=null,cozeBridge=null}){
  const cache=new Map(),pending=new Map(),controllers=new Set();let active=0;
  const ttl=5*60*1000,maxCache=128;
  const paid=async req=>{
    await auth(req);
    if(req.headers['x-float-assistant-billing']!=='token-v1')throw new ApiError(426,'ASSISTANT_BILLING_CLIENT_REQUIRED',
      '对话内置模型已改为按真实token计费，请更新支持计费回执的App后使用；本次未调用模型或扣点');
  };
  const billing=assistantTokenBilling(store);
  await billing.recoverExpired();
  let recoveryTask=null;
  const recovery=setInterval(()=>{
    if(!recoveryTask)recoveryTask=billing.recoverExpired().catch(()=>app.log.error({code:'ASSISTANT_BILLING_RECOVERY_FAILED'},'Assistant settlement recovery failed'))
      .finally(()=>{recoveryTask=null;});
  },30000);
  recovery.unref();
  app.addHook('onClose',async()=>{clearInterval(recovery);if(recoveryTask)await recoveryTask;});
  const knownPrice=config=>{try{return assistantTokenPricing(config);}catch{return null;}};
  const startBilling=async(owner,request,digest,binding,raw)=>{
    const price=assistantTokenPricing(binding.config);
    if(!price)throw new ApiError(422,'ASSISTANT_PRICE_UNAVAILABLE','该实际型号尚无已核验单价，未调用模型');
    const prepared=binding.config.execution==='coze'?prepareCozeAssistant(binding.config,raw):assistantProviderBody(binding.config,request,request.mode==='chat');
    const future=assistantTokenPricing(binding.config,Date.now()+request.timeoutSeconds*1000);
    const ceiling=price.period==='off_peak'&&future?.period==='peak'?future:price;
    const quote=assistantTokenReservation(ceiling,prepared.body);
    return billing.begin(owner,request.requestId,digest,price,quote,request.timeoutSeconds);
  };
  const paidResult=(result,bill)=>{
    if(bill.state!=='settled')throw new ApiError(bill.state==='settlement_pending'?402:502,
      bill.state==='settlement_pending'?'ASSISTANT_POINTS_REQUIRED':'ASSISTANT_USAGE_UNCONFIRMED',
      bill.state==='settlement_pending'?'实际用量结算待补足点数，请充值后继续，未交付工具动作':'供应商未返回可核验的完整用量，未估算扣费或交付工具动作',{billing:bill});
    const value={...result};delete value.testing;
    return {...value,billing:bill,usage:bill.usage};
  };
  const prune=()=>{
    const now=Date.now();
    for(const [key,value] of cache)if(value.expires<=now&&!value.pending)cache.delete(key);
  };
  const unavailable=(item,binding)=>modelUnavailableReason(item,binding)||
    (binding.config.execution==='coze'&&typeof cozeBridge?.assistant!=='function'?'COZE_ASSISTANT_NOT_READY':null);
  const availabilityMessage=reason=>({
    MODEL_NOT_CONFIGURED:'后台尚未绑定所选内置模型，请管理员配置该型号',
    MODEL_KEY_NOT_CONFIGURED:'后台未配置可用的供应商凭据，请管理员检查后台密钥',
    MODEL_CONFIG_MISMATCH:'后台模型绑定与目录配置不一致，请管理员核对模型配置',
    MODEL_NOT_VERIFIED:'后台模型配置或凭据尚未通过当前验证，请管理员完成模型验证',
    MODEL_DISABLED:'后台已停用所选模型，请切换其他可用型号',
    COZE_INTEGRATION_NOT_READY:'后台Coze模型桥接尚未就绪，请管理员检查桥接配置',
    COZE_ASSISTANT_NOT_READY:'后台尚未接入Coze对话JSON规划桥接，请更新对应后台；搜题通道保持原规则',
    COZE_MODEL_LIST_UNAVAILABLE:'暂时无法核对Coze项目开放的实际型号，请稍后重试',
    COZE_MODEL_UNAVAILABLE:'所选实际型号不在当前Coze项目开放列表中，请刷新型号',
  })[reason]||'后台模型配置校验未通过，请根据返回的错误码排查';
  const secretFor=binding=>{
    try{
      const key=modelSecret(binding.config,binding.row,modelMasterKey,baichuanApiKey,deepseekApiKey);
      if(typeof key!=='string'||key.length<8||/[\r\n]/u.test(key))throw new Error('key');
      return key;
    }catch{throw new ApiError(503,'MODEL_KEY_NOT_CONFIGURED','内置模型密钥尚未配置或不可用');}
  };
  const requireDialogueDeepSeek=(item,binding)=>{
    if(item.provider!=='deepseek'||binding&&(binding.config.provider!=='deepseek'||binding.config.execution==='coze'))
      throw new ApiError(422,'ASSISTANT_DEEPSEEK_ONLY','对话目前仅支持DeepSeek，请重新选择');
  };
  app.addHook('onClose',async()=>{for(const controller of controllers)controller.abort();cache.clear();});
  const cozeModels=async()=>{
    try{const metadata=await cozeBridge.metadata();if(!Array.isArray(metadata.items))throw new Error('metadata');return metadata.items;}
    catch{throw new ApiError(503,'COZE_MODEL_LIST_UNAVAILABLE','暂时无法核对Coze实际型号与图片能力');}
  };
  const supportsImagesFor=async binding=>{
    if(binding.config.execution!=='coze')return modelSupportsImages(binding.config.modelId);
    const selected=(await cozeModels()).find(model=>model.model_id===binding.config.modelId);
    if(!selected)throw new ApiError(422,'COZE_MODEL_UNAVAILABLE',availabilityMessage('COZE_MODEL_UNAVAILABLE'));
    return modelSupportsImages(binding.config.modelId,selected.input_types);
  };
  app.get('/v1/assistant/models',{preHandler:auth},async req=>{
    await billing.recover(req.auth.user_id);
    const bindings=await configuredCatalog(store);
    // Dialogue's built-in language selection is independent of search and media's Coze catalogue.
    return {items:MODEL_CATALOG.filter(item=>item.provider==='deepseek'&&bindings.get(item.key)?.config.provider==='deepseek'&&bindings.get(item.key)?.config.execution!=='coze'&&knownPrice(bindings.get(item.key)?.config)).map(item=>{
      const binding=bindings.get(item.key);let reason=unavailable(item,binding);
      if(!reason)try{secretFor(binding);}catch{reason='MODEL_KEY_NOT_CONFIGURED';}
      const supportsImages=!!binding&&modelSupportsImages(binding.config.modelId);
      return {key:item.key,name:item.name,provider:item.provider,
        modelId:binding?.config.modelId??null,thinkingProfile:assistantThinkingProfile(binding?.config??{provider:item.provider}),
        available:!reason,unavailableReason:reason,supportsImages,capabilities:supportsImages?['text','image']:['text'],
        planningProtocol:'native_tools',
        toolsVerified:false,toolsStatus:'unverified',billing:knownPrice(binding.config)};
    }),protocolVersion:2,sessionHistorySupported:true,thinkingConfigVersion:1,clarificationToolsVersion:1,requestStatisticsVersion:1,
      billing:{version:1,mode:'token',pointsPerYuan:20,multiplier:'1.4',requiresClientHeader:'token-v1'}};
  });
  // A single task can legitimately make many sequential model decisions. Do not inherit
  // the HTTP rate plugin's global limit; concurrent/pending work is still bounded below.
  app.post('/v1/assistant/plan',{preHandler:paid,bodyLimit:4*1024*1024,
    config:{rateLimit:false}},async(req,reply)=>{
    const request=assistantRequest(req.body),item=catalogEntry(request.modelKey),bindings=await configuredCatalog(store),binding=bindings.get(request.modelKey);
    if(request.mode==='chat')throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','普通对话请使用对话生成接口');
    if(!item)throw new ApiError(400,'ASSISTANT_MODEL_INVALID','请选择内置目录中的模型');
    requireDialogueDeepSeek(item,binding);
    const reason=unavailable(item,binding);
    if(reason)throw new ApiError(422,reason,availabilityMessage(reason));
    if((request.image||request.visionEnabled)&&!await supportsImagesFor(binding))throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','当前内置型号不支持图片输入，请关闭视觉辅助或更换模型');
    const key=binding.config.execution==='coze'?null:secretFor(binding),owner=req.auth.user_id,requestKey=owner+':'+request.requestId;
    const digest=sha256(JSON.stringify({modelKey:request.modelKey,mode:request.mode,messages:request.messages,
      visionEnabled:request.visionEnabled,thinking:request.thinking,maxOutputTokens:request.maxOutputTokens,expectedModelId:request.expectedModelId,
      revision:binding.row.revision,keyFingerprint:key?sha256(key):'coze-json-v1'}));
    prune();
    const previous=cache.get(requestKey);
    if(previous){
      if(previous.digest!==digest)throw new ApiError(409,'ASSISTANT_IDEMPOTENCY_CONFLICT','同一助手请求编号不能用于不同内容');
      const result=await previous.promise;await paid(req);return result;
    }
    const now=Date.now();
    if(active>=8||(pending.get(owner)||0)>=2)throw new ApiError(429,'ASSISTANT_BUSY','助手已有请求正在处理，请稍后重试');
    if(cache.size>=maxCache){
      const oldest=[...cache].find(([,entry])=>!entry.pending);
      if(oldest)cache.delete(oldest[0]);else throw new ApiError(429,'ASSISTANT_BUSY','助手请求队列已满，请稍后重试');
    }
    active++;pending.set(owner,(pending.get(owner)||0)+1);
    let meter;
    try{meter=await startBilling(owner,request,digest,binding,req.body);}
    catch(error){active--;const count=(pending.get(owner)||1)-1;if(count)pending.set(owner,count);else pending.delete(owner);throw error;}
    const controller=new AbortController();controllers.add(controller);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(req.raw.aborted||reply.raw.destroyed)controller.abort();
    const entry={digest,expires:now+ttl,pending:true,promise:null};
    let actualRequest;
    const operation=(async()=>{
      try{
        if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
        const result=await (binding.config.execution==='coze'?cozeBridge.assistant(binding.config,req.body,controller.signal,undefined,undefined,undefined,meter.captureUsage):
          officialAssistantCompletion(binding.config,key,request,controller.signal,meter.captureUsage,async value=>{actualRequest=value;}));
        const response=paidResult(result,await meter.finish());
        // A session revoked while the provider ran cannot deliver a new phone action.
        await paid(req);
        if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
        return response;
      }catch(error){
        const bill=await meter.finish();
        if(error instanceof ApiError)error.details={...(error.details??{}),billing:bill,...(actualRequest?{request:actualRequest}:{})};
        throw error;
      }finally{
        active--;const count=(pending.get(owner)||1)-1;
        if(count>0)pending.set(owner,count);else pending.delete(owner);
        controllers.delete(controller);req.raw.removeListener('aborted',disconnected);reply.raw.removeListener('close',disconnected);
      }
    })();
    entry.promise=operation.then(result=>{entry.pending=false;return result;},error=>{cache.delete(requestKey);throw error;});
    cache.set(requestKey,entry);
    return entry.promise;
  });

  app.post('/v1/assistant/chat',{preHandler:paid,bodyLimit:4*1024*1024,
    config:{rateLimit:false}},async(req,reply)=>{
    const request=assistantRequest(req.body);
    if(request.mode!=='chat')throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','对话接口只接受chat请求');
    const item=catalogEntry(request.modelKey),bindings=await configuredCatalog(store),binding=bindings.get(request.modelKey);
    if(!item)throw new ApiError(400,'ASSISTANT_MODEL_INVALID','请选择内置目录中的模型');
    requireDialogueDeepSeek(item,binding);
    const reason=unavailable(item,binding);
    if(reason)throw new ApiError(422,reason,availabilityMessage(reason));
    if((request.image||request.availableTools?.includes('take_screenshot'))&&!await supportsImagesFor(binding))
      throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','该模型不支持本次图片或实时截图能力');
    const key=binding.config.execution==='coze'?null:secretFor(binding),owner=req.auth.user_id,requestKey=owner+':'+request.requestId;
    const digest=sha256(JSON.stringify({modelKey:request.modelKey,mode:'chat',protocolVersion:request.protocolVersion,
      availableTools:request.availableTools,visionEnabled:request.visionEnabled,messages:request.messages,
      thinking:request.thinking,maxOutputTokens:request.maxOutputTokens,expectedModelId:request.expectedModelId,
      revision:binding.row.revision,keyFingerprint:key?sha256(key):'coze-json-v1'}));
    prune();
    const previous=cache.get(requestKey);
    if(previous){
      if(previous.digest!==digest)throw new ApiError(409,'ASSISTANT_IDEMPOTENCY_CONFLICT','同一请求编号不能用于不同对话');
      const result=await previous.promise;await paid(req);return result;
    }
    const now=Date.now();
    if(active>=8||(pending.get(owner)||0)>=2)throw new ApiError(429,'ASSISTANT_BUSY','已有对话正在生成，请稍后重试');
    if(cache.size>=maxCache){
      const oldest=[...cache].find(([,entry])=>!entry.pending);
      if(oldest)cache.delete(oldest[0]);else throw new ApiError(429,'ASSISTANT_BUSY','助手请求队列已满');
    }
    active++;pending.set(owner,(pending.get(owner)||0)+1);
    let meter;
    try{meter=await startBilling(owner,request,digest,binding,req.body);}
    catch(error){active--;const count=(pending.get(owner)||1)-1;if(count)pending.set(owner,count);else pending.delete(owner);throw error;}
    const controller=new AbortController();controllers.add(controller);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    if(req.raw.aborted||reply.raw.destroyed)controller.abort();
    let resolvePending,rejectPending;
    const promise=new Promise((resolve,reject)=>{resolvePending=resolve;rejectPending=reject;});promise.catch(()=>{});
    const entry={digest,expires:now+ttl,pending:true,promise};cache.set(requestKey,entry);
    const event=async value=>{
      if(controller.signal.aborted||reply.raw.destroyed)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
      if(!reply.raw.write(`data: ${JSON.stringify(value)}\n\n`))await once(reply.raw,'drain',{signal:controller.signal});
    };
    let actualRequest;
    const captureRequest=async value=>{actualRequest=value;await event({request:value});};
    const captureUsage=async(value,metadata)=>{
      await meter.captureUsage(value,metadata);
      if(binding.config.provider==='deepseek'){
        const counters=displayUsage(value);
        if(counters)await event({usage:counters,...(actualRequest?{request:actualRequest}:{})});
      }
    };
    try{
      if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
      reply.hijack();
      reply.raw.writeHead(200,{...reply.getHeaders(),'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});
      reply.raw.flushHeaders();
      const complete=binding.config.execution==='coze'?
        (onText,onReasoning,onConfiguration)=>cozeBridge.assistant(binding.config,req.body,controller.signal,onText,onReasoning,onConfiguration,meter.captureUsage):
        (onText,onReasoning,onConfiguration)=>officialAssistantChat(binding.config,key,request,controller.signal,onText,onReasoning,onConfiguration,captureUsage,captureRequest);
      const raw=await complete(async text=>{
        await event({choices:[{index:0,delta:{content:text},finish_reason:null}]});
      },async reasoning=>{
        await event({choices:[{index:0,delta:{reasoning_content:reasoning},finish_reason:null}]});
      },async configuration=>{
        await event({configuration});
      });
      // A native phone signal is withheld until the current session is checked again.
      const result=paidResult(raw,await meter.finish());
      await paid(req);
      if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
      const choice=result.choices[0];
      if(request.protocolVersion===2)result.protocolVersion=2;
      await event({choices:[{index:0,delta:{...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls}:{})},finish_reason:choice.finish_reason}],
        ...(request.protocolVersion===2?{protocolVersion:2}:{}),...(result.tool_validation?{tool_validation:result.tool_validation}:{}),
        ...(result.configuration?{configuration:result.configuration}:{}),...(actualRequest?{request:actualRequest}:{}),billing:result.billing,usage:result.usage});
      entry.pending=false;resolvePending(result);
      reply.raw.end('data: [DONE]\n\n');
    }catch(error){
      const bill=await meter.finish();
      cache.delete(requestKey);rejectPending(error);
      if(!reply.raw.destroyed&&!controller.signal.aborted){
        const code=error instanceof ApiError?error.code:'MODEL_CHAT_FAILED';
        const upstreamDiagnostic=assistantErrorDiagnostic(error);
        const diagnostic=upstreamDiagnostic||assistantBackendDiagnostic(error,{phase:'backend_stream',code});
        const reason=error instanceof ApiError?error.message:`业务后台处理模型响应时发生异常（${diagnostic.exception_type}），尚未确定具体原因`;
        const message=upstreamDiagnostic?reason:`${reason}。后台追查编号：${diagnostic.request_id}`;
        reply.raw.end(`data: ${JSON.stringify({error:{code,message,requestId:diagnostic.request_id,diagnostic,retryable:diagnostic.retryable},
          ...(actualRequest?{request:actualRequest}:{}),billing:bill})}\n\n`);
      }
    }finally{
      active--;const count=(pending.get(owner)||1)-1;
      if(count>0)pending.set(owner,count);else pending.delete(owner);
      controllers.delete(controller);req.raw.removeListener('aborted',disconnected);reply.raw.removeListener('close',disconnected);
      if(!reply.raw.writableEnded&&!reply.raw.destroyed)reply.raw.end();
    }
  });
}
