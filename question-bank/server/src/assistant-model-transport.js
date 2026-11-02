import {ApiError} from './security.js';
import {MODEL_ORIGINS} from './models.js';
import {assistantResult,assistantChatResult,assistantTurnResult,ASSISTANT_SESSION_ARGUMENTS_LIMIT} from './assistant-protocol.js';
import {applyAssistantThinking} from './assistant-thinking.js';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const responseError=(code,message)=>new ApiError(502,code,message);

function providerBody(config,request,stream){
  const body={model:config.modelId,messages:request.messages,
    ...(request.tools.length?{tools:request.tools,parallel_tool_calls:false}:{}),
    tool_choice:stream?'auto':'required',stream,max_tokens:stream?4096:1500};
  // Old clients keep their original request behaviour. New configuration is profile checked.
  if(request.thinking===undefined&&request.protocolVersion!==2){
    if(config.provider==='qwen')body.enable_thinking=false;
    else if(config.provider==='minimax')body.reasoning_split=true;
    else if(config.provider!=='baichuan')body.thinking={type:'disabled'};
  }
  const configuration=applyAssistantThinking(config,request,body);
  return {body,configuration};
}

function assertProvider(config){
  if((config.execution!==undefined&&config.execution!=='official')||MODEL_ORIGINS[config.provider]!==config.baseUrl)
    throw new ApiError(422,'MODEL_ASSISTANT_UNSUPPORTED','该模型当前没有可用的助手工具调用通道');
}

// Diagnostics classify failures only; raw provider fields never leave the server.
async function providerDiagnostic(response){
  if(!response.body)return {};
  const reader=response.body.getReader(),parts=[];let size=0;
  try{
    while(true){
      const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>32768)break;parts.push(value);
    }
    let result;try{result=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{return {};}
    const error=record(result?.error)?result.error:{};
    return {param:typeof error.param==='string'?error.param:'',message:typeof error.message==='string'?error.message.toLowerCase():''};
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

function upstreamError(status,diagnostic={}){
  if([401,403].includes(status))return new ApiError(503,'MODEL_AUTH_UNAVAILABLE','内置模型授权不可用，请检查后台配置');
  if(status===404)return new ApiError(422,'MODEL_NOT_FOUND','内置模型不存在或接口未提供');
  if(status===429)return new ApiError(429,'MODEL_RATE_LIMITED','内置模型暂时繁忙，请稍后重试');
  if([400,405,415,422].includes(status)){
    const {param='',message=''}=diagnostic;
    if(['thinking','thinking.type','thinking.clear_thinking','enable_thinking','reasoning_effort','reasoning_split'].includes(param))
      return new ApiError(422,'THINKING_PARAMETER_REJECTED',`模型接口拒绝了当前思考配置字段 ${param}，请核对具体型号与兼容能力`);
    if(message.includes('reasoning_content'))return new ApiError(422,'MODEL_REASONING_HISTORY_REJECTED','模型接口没有接受原生思考历史字段，请核对该实际型号的工具历史要求');
    if(/unsupported|not support|not available|does not support/u.test(message)){
      if(/tool|function/u.test(param+' '+message))return new ApiError(422,'MODEL_TOOLS_UNSUPPORTED','模型接口明确不支持本次工具调用能力');
      if(/image|vision/u.test(param+' '+message))return new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','模型接口明确不支持本次图片能力');
      return new ApiError(422,'MODEL_CAPABILITY_UNSUPPORTED','模型接口明确不支持本次请求能力');
    }
    return new ApiError(422,'MODEL_REQUEST_REJECTED','模型接口拒绝了本次请求参数，请检查模型配置');
  }
  return responseError('MODEL_UPSTREAM_FAILED','内置模型服务调用失败，请稍后重试');
}

/** User-started legacy planning and probes; phone actions are never retried here. */
export async function officialAssistantCompletion(config,apiKey,request,signal){
  assertProvider(config);
  const {body,configuration}=providerBody(config,request,false),deadline=AbortSignal.timeout(Math.min(request.timeoutSeconds*1000,120000));
  const combined=AbortSignal.any([signal,deadline]);
  const fail=()=>new ApiError(deadline.aborted?504:502,deadline.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_ERROR','内置模型连接中断，请稍后重试');
  try{
    const response=await fetch(`${config.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:combined,
      headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'application/json','cache-control':'no-store'},body:JSON.stringify(body)});
    if(!response.ok)throw upstreamError(response.status,await providerDiagnostic(response));
    if(!response.body)throw responseError('MODEL_RESPONSE_EMPTY','模型没有返回响应正文');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{
      while(true){
        if(combined.aborted)throw fail();
        const {done,value}=await reader.read();if(done)break;size+=value.length;
        if(size>(request.thinking?1536:256)*1024)throw responseError('MODEL_RESPONSE_TOO_LARGE','模型响应超出本机处理范围，未截断或执行');
        chunks.push(value);
      }
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    const raw=Buffer.concat(chunks).toString('utf8');
    if(raw.includes(apiKey))throw responseError('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
    let result;try{result=JSON.parse(raw);}catch{throw responseError('MODEL_RESPONSE_JSON_INVALID','模型未返回有效的Chat Completions JSON');}
    return {...assistantResult(result,request.tools),...(configuration?{configuration:{...configuration,request_state:'provider_http_accepted',profile_source:'trusted_binding'}}:{})};
  }catch(error){
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
    if(error instanceof ApiError)throw error;
    throw fail();
  }
}

/** Stream real content/reasoning_content independently; tools wait for a valid terminal turn. */
export async function officialAssistantChat(config,apiKey,request,signal,onText=async()=>{},onReasoning=async()=>{},onConfiguration=async()=>{}){
  assertProvider(config);
  const {body,configuration}=providerBody(config,request,true),deadline=AbortSignal.timeout(Math.min(request.timeoutSeconds*1000,120000));
  const combined=AbortSignal.any([signal,deadline]);
  const fail=()=>new ApiError(deadline.aborted?504:502,deadline.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_ERROR','模型对话连接中断，请重试');
  const normalize=request.protocolVersion===2?assistantTurnResult:assistantChatResult;
  const argumentsLimit=request.protocolVersion===2?ASSISTANT_SESSION_ARGUMENTS_LIMIT:16384;
  const responseBytesLimit=(request.protocolVersion===2?1536:512)*1024;
  const frameCharactersLimit=(request.protocolVersion===2?1024:256)*1024;
  try{
    const send=()=>fetch(`${config.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:combined,
      headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'text/event-stream, application/json','cache-control':'no-store'},body:JSON.stringify(body)});
    let response=await send(),diagnostic;
    // Parameter compatibility retries precede any public text, reasoning or tool signal.
    for(let attempt=0;attempt<2&&[400,422].includes(response.status);attempt++){
      diagnostic=await providerDiagnostic(response);
      const {param='',message=''}=diagnostic;
      if(body.max_tokens!==undefined&&(param==='max_tokens'||message.includes('max_completion_tokens'))){body.max_completion_tokens=body.max_tokens;delete body.max_tokens;}
      else if(body.stream&&(param==='stream'||message.includes('stream'))&&/unsupported|not support|not available/u.test(message))body.stream=false;
      else break;
      response=await send();diagnostic=undefined;
    }
    if(!response.ok)throw upstreamError(response.status,diagnostic??await providerDiagnostic(response));
    if(!response.body)throw responseError('MODEL_RESPONSE_EMPTY','模型没有返回对话正文');
    if(configuration){
      configuration.parameters=Object.fromEntries(['thinking','enable_thinking','reasoning_effort','reasoning_split','max_tokens','max_completion_tokens'].filter(name=>Object.hasOwn(body,name)).map(name=>[name,body[name]]));
      configuration.request_state='provider_http_accepted';configuration.profile_source='trusted_binding';
      await onConfiguration(configuration);
    }
    const streaming=response.headers.get('content-type')?.includes('text/event-stream');
    const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];
    let received=0,buffer='',name='',args='',callId='',callType='',finish='',ended=false,hasTool=false;
    const channels={content:{value:'',held:'',max:24000,seen:false,emit:onText},reasoning_content:{value:'',held:'',max:512*1024,seen:false,emit:onReasoning}};
    const emit=async (channel,text)=>{
      if(combined.aborted)throw fail();
      const state=channels[channel];state.seen=true;state.value+=text;state.held+=text;
      if(state.value.length>state.max)throw responseError('MODEL_RESPONSE_TOO_LARGE','模型正文或思考字段超出处理范围');
      if(state.value.includes(apiKey))throw responseError('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
      // Hold each channel's suffix so a split key cannot be emitted in full.
      const safe=state.held.length-apiKey.length+1;
      if(safe>0){await state.emit(state.held.slice(0,safe));state.held=state.held.slice(safe);}
    };
    const frame=async raw=>{
      const data=raw.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return;
      if(data==='[DONE]'){ended=true;return;}
      let event;try{event=JSON.parse(data);}catch{throw responseError('MODEL_STREAM_JSON_INVALID','模型流式事件不是有效JSON');}
      if(!record(event))throw responseError('MODEL_STREAM_INVALID','模型流式事件结构无效');
      if(event.error)throw responseError('MODEL_UPSTREAM_FAILED','模型服务中断了本次输出');
      if(!Array.isArray(event.choices))throw responseError('MODEL_STREAM_INVALID','模型流式事件缺少候选');
      if(event.choices.length===0)return;
      if(event.choices.length!==1)throw responseError('MODEL_RESPONSE_INVALID','模型返回多个对话候选');
      const choice=event.choices[0],delta=choice?.delta??{};
      if(!record(delta))throw responseError('MODEL_STREAM_INVALID','模型增量消息结构无效');
      if(delta.role!==undefined&&delta.role!=='assistant')throw responseError('MODEL_STREAM_INVALID','模型增量角色无效');
      if(finish)throw responseError('MODEL_STREAM_INVALID','模型在终态后继续返回消息');
      // All three fields may coexist in one delta.
      for(const channel of ['content','reasoning_content']){
        if(delta[channel]!==undefined&&delta[channel]!==null){
          if(typeof delta[channel]!=='string')throw responseError('MODEL_STREAM_INVALID','模型增量文本字段无效');
          await emit(channel,delta[channel]);
        }
      }
      if(delta.tool_calls!==undefined&&delta.tool_calls!==null){
        if(!Array.isArray(delta.tool_calls)||delta.tool_calls.length>1)throw responseError('MODEL_TOOL_CALL_INVALID','每轮只接受一个工具调用');
        for(const call of delta.tool_calls){
          if(!record(call)||(call.index??0)!==0)throw responseError('MODEL_TOOL_CALL_INVALID','工具增量索引无效');
          hasTool=true;
          if(call.id!==undefined){
            if(typeof call.id!=='string'||callId&&call.id!==callId)throw responseError('MODEL_TOOL_CALL_ID_INVALID','工具增量编号不一致');
            callId=call.id;
          }
          if(call.type!==undefined){
            if(call.type!=='function')throw responseError('MODEL_TOOL_CALL_INVALID','工具调用类型无效');callType=call.type;
          }
          if(call.function!==undefined){
            if(!record(call.function))throw responseError('MODEL_TOOL_CALL_INVALID','工具增量函数结构无效');
            if(call.function.name!==undefined){
              if(typeof call.function.name!=='string')throw responseError('MODEL_TOOL_CALL_INVALID','工具增量名称无效');name+=call.function.name;
            }
            if(call.function.arguments!==undefined){
              if(typeof call.function.arguments!=='string')throw responseError('MODEL_TOOL_ARGUMENTS_INVALID','工具参数增量无效');args+=call.function.arguments;
            }
          }
          if(name.length>100||args.length>argumentsLimit)throw responseError('MODEL_TOOL_ARGUMENTS_INVALID','工具参数超出处理范围，未截断或执行');
        }
      }
      if(choice?.finish_reason!==undefined&&choice.finish_reason!==null){
        if(typeof choice.finish_reason!=='string'||!choice.finish_reason)throw responseError('MODEL_STREAM_INVALID','模型终态字段无效');finish=choice.finish_reason;
      }
    };
    try{
      while(!ended){
        if(combined.aborted)throw fail();
        const {done,value}=await reader.read();if(done)break;received+=value.length;
        if(received>responseBytesLimit)throw responseError('MODEL_RESPONSE_TOO_LARGE','模型对话响应超过处理上限，未截断或执行');
        if(!streaming){parts.push(value);continue;}
        buffer+=decoder.decode(value,{stream:true});
        let boundary;
        while(!ended&&(boundary=/\r?\n\r?\n/u.exec(buffer))!==null){
          const raw=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);await frame(raw);
        }
        if(buffer.length>frameCharactersLimit)throw responseError('MODEL_RESPONSE_TOO_LARGE','单个流式事件过大，未截断或执行');
      }
      if(streaming&&!ended){buffer+=decoder.decode();if(buffer.trim())await frame(buffer);}
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!streaming){
      const raw=Buffer.concat(parts).toString('utf8');
      if(raw.includes(apiKey))throw responseError('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
      let parsed;try{parsed=JSON.parse(raw);}catch{throw responseError('MODEL_RESPONSE_JSON_INVALID','模型没有返回有效对话JSON');}
      const result=normalize(parsed,request.tools),message=result.choices[0].message;
      if(message.reasoning_content)await onReasoning(message.reasoning_content);
      if(message.content)await onText(message.content);
      return {...result,...(configuration?{configuration}:{})};
    }
    if(!ended||!finish)throw responseError('MODEL_STREAM_INCOMPLETE','模型流式响应未完整结束，请重试');
    if([callId,name,args].some(value=>value.includes(apiKey)))throw responseError('MODEL_RESPONSE_SENSITIVE','模型工具响应包含不应公开的服务信息');
    const result=normalize({choices:[{finish_reason:finish,message:{role:'assistant',content:channels.content.value,
      ...(channels.reasoning_content.seen?{reasoning_content:channels.reasoning_content.value}:{}),
      ...(hasTool?{tool_calls:[{id:callId,type:callType||'function',function:{name,arguments:args}}]}:{})}}]},request.tools);
    for(const channel of ['reasoning_content','content'])if(channels[channel].held)await channels[channel].emit(channels[channel].held);
    return {...result,...(configuration?{configuration}:{})};
  }catch(error){
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
    if(error instanceof ApiError)throw error;
    throw fail();
  }
}
