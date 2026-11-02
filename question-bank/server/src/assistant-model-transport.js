import {ApiError} from './security.js';
import {MODEL_ORIGINS} from './models.js';
import {assistantResult,assistantChatResult} from './assistant-protocol.js';

/** The user starts each request. This path never uses the answer-only transport or retries itself. */
export async function officialAssistantCompletion(config,apiKey,request,signal){
  if((config.execution!==undefined&&config.execution!=='official')||MODEL_ORIGINS[config.provider]!==config.baseUrl)
    throw new ApiError(422,'MODEL_ASSISTANT_UNSUPPORTED','该模型当前没有可用的助手工具调用通道');
  const body={model:config.modelId,messages:request.messages,tools:request.tools,tool_choice:'required',parallel_tool_calls:false,
    stream:false,max_tokens:1500};
  // Keep each planning turn independent of vendor reasoning history requirements.
  if(config.provider==='qwen')body.enable_thinking=false;
  else if(config.provider==='minimax')body.reasoning_split=true;
  else if(config.provider!=='baichuan')body.thinking={type:'disabled'};
  const timeout=Math.min(request.timeoutSeconds*1000,120000);
  const deadline=AbortSignal.timeout(timeout),combined=AbortSignal.any([signal,deadline]);
  let response;
  try{response=await fetch(`${config.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:combined,
    headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'application/json','cache-control':'no-store'},body:JSON.stringify(body)});}
  catch{
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
    throw new ApiError(deadline.aborted?504:502,deadline.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_ERROR',deadline.aborted?'内置模型响应超时，请稍后重试':'无法连接内置模型服务，请稍后重试');
  }
  if(!response.ok){
    await response.body?.cancel();
    if(response.status===401||response.status===403)throw new ApiError(503,'MODEL_AUTH_UNAVAILABLE','内置模型授权不可用，请检查后台模型配置');
    if(response.status===404)throw new ApiError(422,'MODEL_NOT_FOUND','内置模型不存在或接口地址不支持该型号');
    if(response.status===429)throw new ApiError(429,'MODEL_RATE_LIMITED','内置模型服务繁忙，请稍后重试');
    if([400,405,415,422].includes(response.status))throw new ApiError(422,'MODEL_TOOLS_INCOMPATIBLE','内置模型接口不兼容工具或图片请求，请换用其他模型');
    throw new ApiError(502,'MODEL_UPSTREAM_FAILED','内置模型服务调用失败，请稍后重试');
  }
  if(!response.body)throw new ApiError(502,'MODEL_TOOLS_INCOMPATIBLE','模型没有返回工具响应');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{
    while(true){
      if(combined.aborted)throw new Error('cancelled');
      const {done,value}=await reader.read();if(done)break;size+=value.length;
      if(size>256*1024){await reader.cancel();throw new ApiError(502,'MODEL_RESPONSE_TOO_LARGE','内置模型响应超出处理范围');}
      chunks.push(value);
    }
  }catch(error){
    if(error instanceof ApiError)throw error;
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','助手请求已取消');
    throw new ApiError(deadline.aborted?504:502,deadline.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_ERROR','内置模型响应中断，请稍后重试');
  }finally{reader.releaseLock();}
  const raw=Buffer.concat(chunks).toString('utf8');
  if(raw.includes(apiKey))throw new ApiError(502,'MODEL_TOOLS_INCOMPATIBLE','模型响应格式无效');
  let result;try{result=JSON.parse(raw);}catch{throw new ApiError(502,'MODEL_TOOLS_INCOMPATIBLE','模型未返回有效的Chat Completions响应');}
  return assistantResult(result,request.tools);
}

/** User-started answer streaming. Only content deltas leave this transport, never private reasoning. */
export async function officialAssistantChat(config,apiKey,request,signal,onText){
  if((config.execution!==undefined&&config.execution!=='official')||MODEL_ORIGINS[config.provider]!==config.baseUrl)
    throw new ApiError(422,'MODEL_ASSISTANT_UNSUPPORTED','该模型没有可用的对话工具通道');
  const body={model:config.modelId,messages:request.messages,tools:request.tools,tool_choice:'auto',parallel_tool_calls:false,
    stream:true,max_tokens:4096};
  if(config.provider==='qwen')body.enable_thinking=false;
  else if(config.provider==='minimax')body.reasoning_split=true;
  else if(config.provider!=='baichuan')body.thinking={type:'disabled'};
  const deadline=AbortSignal.timeout(Math.min(request.timeoutSeconds*1000,120000)),combined=AbortSignal.any([signal,deadline]);
  const fail=()=>new ApiError(deadline.aborted?504:502,deadline.aborted?'MODEL_TIMEOUT':'MODEL_NETWORK_ERROR','模型对话连接中断，请重试');
  let response;
  try{
    const send=()=>fetch(`${config.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:combined,
      headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json',accept:'text/event-stream, application/json','cache-control':'no-store'},body:JSON.stringify(body)});
    response=await send();
    // Compatibility retries happen before any public content or tool signal is delivered.
    for(let attempt=0;attempt<2&&[400,422].includes(response.status);attempt++){
      let error;
      if(response.body){
        const input=response.body.getReader(),chunks=[];let size=0;
        try{while(true){const part=await input.read();if(part.done)break;size+=part.value.length;if(size>32768)break;chunks.push(part.value);}}
        finally{await input.cancel().catch(()=>{});input.releaseLock();}
        try{error=JSON.parse(Buffer.concat(chunks).toString('utf8')).error;}catch{}
      }
      const param=typeof error?.param==='string'?error.param:'',message=typeof error?.message==='string'?error.message.toLowerCase():'';
      if(body.max_tokens!==undefined&&(param==='max_tokens'||message.includes('max_completion_tokens'))){body.max_completion_tokens=body.max_tokens;delete body.max_tokens;}
      else if(body.stream&&(param==='stream'||message.includes('stream'))&&/unsupported|not support|not available/u.test(message))body.stream=false;
      else break;
      response=await send();
    }
    if(!response.ok){
      await response.body?.cancel();
      if([401,403].includes(response.status))throw new ApiError(503,'MODEL_AUTH_UNAVAILABLE','内置模型授权不可用');
      if(response.status===404)throw new ApiError(422,'MODEL_NOT_FOUND','内置对话模型不存在或接口未提供');
      if(response.status===429)throw new ApiError(429,'MODEL_RATE_LIMITED','内置模型暂时繁忙');
      throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型未接受本次对话或工具请求');
    }
    if(!response.body)throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型没有返回对话');
    const streaming=response.headers.get('content-type')?.includes('text/event-stream');
    const reader=response.body.getReader(),decoder=new TextDecoder(),parts=[];
    let received=0,buffer='',answer='',held='',name='',args='',callId='assistant_control',finish='',ended=false;
    const emit=async text=>{
      if(combined.aborted)throw fail();
      if(answer.length+text.length>24000)throw new ApiError(502,'MODEL_RESPONSE_TOO_LARGE','本次回答超过处理上限');
      answer+=text;held+=text;
      if(answer.includes(apiKey))throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型响应包含不应公开的服务信息');
      // Hold a short suffix so a key split between deltas can never be emitted in full.
      const safe=held.length-apiKey.length+1;
      if(safe>0){await onText(held.slice(0,safe));held=held.slice(safe);}
    };
    const frame=async raw=>{
      const data=raw.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return;
      if(data==='[DONE]'){ended=true;return;}
      let event;try{event=JSON.parse(data);}catch{throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','流式事件不是有效JSON');}
      if(event.error)throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型中断了对话');
      if(!Array.isArray(event.choices)||event.choices.length===0)return;
      if(event.choices.length!==1)throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型返回多个对话候选');
      const choice=event.choices[0],delta=choice.delta??{};
      if(typeof delta.content==='string')await emit(delta.content);
      if(delta.tool_calls!==undefined){
        if(!Array.isArray(delta.tool_calls))throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','工具流格式无效');
        for(const call of delta.tool_calls){
          if((call.index??0)!==0)throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','单轮对话只能启动一个手机任务');
          if(typeof call.id==='string')callId=call.id;
          if(typeof call.function?.name==='string')name+=call.function.name;
          if(typeof call.function?.arguments==='string')args+=call.function.arguments;
          if(name.length>100||args.length>16384)throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','工具参数过长');
        }
      }
      if(typeof choice.finish_reason==='string')finish=choice.finish_reason;
    };
    try{
      while(!ended){
        if(combined.aborted)throw fail();
        const {done,value}=await reader.read();if(done)break;
        received+=value.length;
        if(received>512*1024)throw new ApiError(502,'MODEL_RESPONSE_TOO_LARGE','模型对话流超过处理上限');
        if(!streaming){parts.push(value);continue;}
        buffer+=decoder.decode(value,{stream:true});
        let boundary;
        while((boundary=/\r?\n\r?\n/u.exec(buffer))!==null){
          const raw=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);await frame(raw);
        }
        if(buffer.length>64*1024)throw new ApiError(502,'MODEL_RESPONSE_TOO_LARGE','单个流式事件过大');
      }
      if(streaming){buffer+=decoder.decode();if(buffer.trim())await frame(buffer);}
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!streaming){
      const raw=Buffer.concat(parts).toString('utf8');
      if(raw.includes(apiKey))throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型响应格式无效');
      let parsed;try{parsed=JSON.parse(raw);}catch{throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型没有返回有效对话JSON');}
      const result=assistantChatResult(parsed,request.tools);
      if(result.choices[0].message.content)await onText(result.choices[0].message.content);
      return result;
    }
    const result=assistantChatResult({choices:[{finish_reason:finish,message:{content:answer,
      ...(name?{tool_calls:[{id:callId,type:'function',function:{name,arguments:args}}]}:{})}}]},request.tools);
    if(args.includes(apiKey))throw new ApiError(502,'MODEL_CHAT_INCOMPATIBLE','模型工具响应包含不应公开的服务信息');
    if(held)await onText(held);
    return result;
  }catch(error){
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消');
    if(error instanceof ApiError)throw error;
    throw fail();
  }
}
