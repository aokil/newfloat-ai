import {ApiError,sha256} from './security.js';
import {MODEL_CATALOG,catalogEntry,configuredCatalog,modelUnavailableReason} from './model-catalog.js';
import {modelSecret} from './models.js';
import {modelSupportsImages} from './ai-image.js';
import {assistantRequest} from './assistant-protocol.js';
import {officialAssistantCompletion} from './assistant-model-transport.js';
import {officialAssistantChat} from './assistant-model-transport.js';
import {once} from 'node:events';

// This explicitly requested temporary path is admin-only and never touches the points ledger.
export async function assistantRoutes(app,{store,auth,modelMasterKey,baichuanApiKey=null,deepseekApiKey=null,rateLimits=true}){
  const cache=new Map(),pending=new Map(),recent=new Map(),controllers=new Set();let active=0;
  const ttl=5*60*1000,maxCache=128;
  const admin=async req=>{await auth(req);if(req.auth.role!=='admin')throw new ApiError(403,'ASSISTANT_ADMIN_ONLY','内置助手当前仅供管理员测试');};
  const prune=()=>{
    const now=Date.now();
    for(const [key,value] of cache)if(value.expires<=now&&!value.pending)cache.delete(key);
    for(const [key,value] of recent)if(value.at(-1)<=now-60000)recent.delete(key);
  };
  const unavailable=(item,binding)=>modelUnavailableReason(item,binding)||
    (binding.config.execution==='coze'?'MODEL_ASSISTANT_UNSUPPORTED':null);
  const secretFor=binding=>{
    try{
      const key=modelSecret(binding.config,binding.row,modelMasterKey,baichuanApiKey,deepseekApiKey);
      if(typeof key!=='string'||key.length<8||/[\r\n]/u.test(key))throw new Error('key');
      return key;
    }catch{throw new ApiError(503,'MODEL_KEY_NOT_CONFIGURED','内置模型密钥尚未配置或不可用');}
  };
  app.addHook('onClose',async()=>{for(const controller of controllers)controller.abort();cache.clear();recent.clear();});
  app.get('/v1/assistant/models',{preHandler:admin},async()=>{
    const bindings=await configuredCatalog(store);
    return {items:MODEL_CATALOG.map(item=>{
      const binding=bindings.get(item.key);let reason=unavailable(item,binding);
      if(!reason)try{secretFor(binding);}catch{reason='MODEL_KEY_NOT_CONFIGURED';}
      const supportsImages=!!binding&&binding.config.execution!=='coze'&&modelSupportsImages(binding.config.modelId);
      return {key:item.key,name:binding?.config.execution==='coze'?binding.config.displayName:item.name,provider:item.provider,
        available:!reason,unavailableReason:reason,supportsImages,capabilities:supportsImages?['text','image']:['text'],
        toolsVerified:false,toolsStatus:'unverified'};
    }),testing:{adminOnly:true,pointsCharged:0}};
  });
  app.post('/v1/assistant/plan',{preHandler:admin,bodyLimit:4*1024*1024,
    config:{rateLimit:rateLimits?{max:20,timeWindow:'1 minute'}:false}},async(req,reply)=>{
    const request=assistantRequest(req.body),item=catalogEntry(request.modelKey),bindings=await configuredCatalog(store),binding=bindings.get(request.modelKey);
    if(request.mode==='chat')throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','普通对话请使用对话生成接口');
    if(!item)throw new ApiError(400,'ASSISTANT_MODEL_INVALID','请选择内置目录中的模型');
    const reason=unavailable(item,binding);
    if(reason)throw new ApiError(422,reason,reason==='MODEL_ASSISTANT_UNSUPPORTED'?'该Coze内置型号当前不支持助手工具调用，请选择可用型号或自定义模型':'该内置模型尚未就绪，请检查模型配置和启用状态');
    if((request.image||request.visionEnabled)&&!modelSupportsImages(binding.config.modelId))throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','当前内置型号不支持图片输入，请关闭视觉辅助或更换模型');
    const key=secretFor(binding),owner=req.auth.user_id,requestKey=owner+':'+request.requestId;
    const digest=sha256(JSON.stringify({modelKey:request.modelKey,mode:request.mode,messages:request.messages,
      visionEnabled:request.visionEnabled,revision:binding.row.revision,keyFingerprint:sha256(key)}));
    prune();
    const previous=cache.get(requestKey);
    if(previous){
      if(previous.digest!==digest)throw new ApiError(409,'ASSISTANT_IDEMPOTENCY_CONFLICT','同一助手请求编号不能用于不同内容');
      return previous.promise;
    }
    const now=Date.now(),times=(recent.get(owner)||[]).filter(at=>at>now-60000);
    if(rateLimits&&times.length>=20)throw new ApiError(429,'ASSISTANT_RATE_LIMITED','助手调用过于频繁，请稍后重试');
    if(active>=8||(pending.get(owner)||0)>=2)throw new ApiError(429,'ASSISTANT_BUSY','助手已有请求正在处理，请稍后重试');
    if(cache.size>=maxCache){
      const oldest=[...cache].find(([,entry])=>!entry.pending);
      if(oldest)cache.delete(oldest[0]);else throw new ApiError(429,'ASSISTANT_BUSY','助手请求队列已满，请稍后重试');
    }
    recent.set(owner,[...times,now]);
    const controller=new AbortController();controllers.add(controller);active++;pending.set(owner,(pending.get(owner)||0)+1);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    const entry={digest,expires:now+ttl,pending:true,promise:null};
    const operation=(async()=>{
      try{
        const result=await officialAssistantCompletion(binding.config,key,request,controller.signal);
        // A session revoked while the provider ran cannot deliver a new phone action.
        await admin(req);
        if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
        return result;
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

  app.post('/v1/assistant/chat',{preHandler:admin,bodyLimit:4*1024*1024,
    config:{rateLimit:rateLimits?{max:20,timeWindow:'1 minute'}:false}},async(req,reply)=>{
    const request=assistantRequest(req.body);
    if(request.mode!=='chat')throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','对话接口只接受chat请求');
    const item=catalogEntry(request.modelKey),bindings=await configuredCatalog(store),binding=bindings.get(request.modelKey);
    if(!item)throw new ApiError(400,'ASSISTANT_MODEL_INVALID','请选择内置目录中的模型');
    const reason=unavailable(item,binding);
    if(reason)throw new ApiError(422,reason,reason==='MODEL_ASSISTANT_UNSUPPORTED'?'该Coze通道暂不支持本助手对话，请选择官方通道或自定义模型':'当前内置模型尚未就绪');
    if(request.image&&!modelSupportsImages(binding.config.modelId))throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','该模型不支持附件图片');
    const key=secretFor(binding),owner=req.auth.user_id,requestKey=owner+':'+request.requestId;
    const digest=sha256(JSON.stringify({modelKey:request.modelKey,mode:'chat',messages:request.messages,
      revision:binding.row.revision,keyFingerprint:sha256(key)}));
    prune();
    const previous=cache.get(requestKey);
    if(previous){
      if(previous.digest!==digest)throw new ApiError(409,'ASSISTANT_IDEMPOTENCY_CONFLICT','同一请求编号不能用于不同对话');
      const result=await previous.promise;await admin(req);return result;
    }
    const now=Date.now(),times=(recent.get(owner)||[]).filter(at=>at>now-60000);
    if(rateLimits&&times.length>=20)throw new ApiError(429,'ASSISTANT_RATE_LIMITED','助手调用过于频繁，请稍后重试');
    if(active>=8||(pending.get(owner)||0)>=2)throw new ApiError(429,'ASSISTANT_BUSY','已有对话正在生成，请稍后重试');
    if(cache.size>=maxCache){
      const oldest=[...cache].find(([,entry])=>!entry.pending);
      if(oldest)cache.delete(oldest[0]);else throw new ApiError(429,'ASSISTANT_BUSY','助手请求队列已满');
    }
    recent.set(owner,[...times,now]);
    const controller=new AbortController();controllers.add(controller);active++;pending.set(owner,(pending.get(owner)||0)+1);
    const disconnected=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',disconnected);reply.raw.once('close',disconnected);
    let resolvePending,rejectPending;
    const promise=new Promise((resolve,reject)=>{resolvePending=resolve;rejectPending=reject;});promise.catch(()=>{});
    const entry={digest,expires:now+ttl,pending:true,promise};cache.set(requestKey,entry);
    reply.hijack();
    reply.raw.writeHead(200,{...reply.getHeaders(),'content-type':'text/event-stream; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'});
    reply.raw.flushHeaders();
    const event=async value=>{
      if(controller.signal.aborted||reply.raw.destroyed)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
      if(!reply.raw.write(`data: ${JSON.stringify(value)}\n\n`))await once(reply.raw,'drain',{signal:controller.signal});
    };
    try{
      const result=await officialAssistantChat(binding.config,key,request,controller.signal,async text=>{
        await event({choices:[{index:0,delta:{content:text},finish_reason:null}]});
      });
      // A native phone signal is withheld until the current session is checked again.
      await admin(req);
      if(controller.signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
      const choice=result.choices[0];
      await event({choices:[{index:0,delta:{...(choice.message.tool_calls?{tool_calls:choice.message.tool_calls}:{})},finish_reason:choice.finish_reason}],testing:result.testing});
      entry.pending=false;resolvePending(result);
      reply.raw.end('data: [DONE]\n\n');
    }catch(error){
      cache.delete(requestKey);rejectPending(error);
      if(!reply.raw.destroyed&&!controller.signal.aborted){
        reply.raw.end(`data: ${JSON.stringify({error:{code:error instanceof ApiError?error.code:'MODEL_CHAT_FAILED',message:'对话连接中断，请重试'}})}\n\n`);
      }
    }finally{
      active--;const count=(pending.get(owner)||1)-1;
      if(count>0)pending.set(owner,count);else pending.delete(owner);
      controllers.delete(controller);req.raw.removeListener('aborted',disconnected);reply.raw.removeListener('close',disconnected);
      if(!reply.raw.writableEnded&&!reply.raw.destroyed)reply.raw.end();
    }
  });
}
