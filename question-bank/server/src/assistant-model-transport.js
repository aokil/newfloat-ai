import {ApiError} from './security.js';
import {MODEL_ORIGINS} from './models.js';
import {assistantResult} from './assistant-protocol.js';

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
