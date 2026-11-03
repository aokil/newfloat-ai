import {ApiError} from './security.js';
import {randomUUID} from 'node:crypto';

const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const names={deepseek:'DeepSeek',qwen:'Qwen',glm:'GLM',minimax:'MiniMax',doubao:'豆包',baichuan:'百川'};
const diagnosticFields=new Set(['provider','model_id','request_id','backend_http_status','upstream_http_status','upstream_request_id',
  'provider_error_code','provider_error_type','parameter','phase','transport_code','exception_type','retryable']);

// Error bodies can echo prompts or credentials. Only identifier-shaped metadata is public.
function identifier(value,secret,maximum=128){
  if(typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=999999)value=String(value);
  if(typeof value!=='string'||!value||value.length>maximum||!value.match(/^[A-Za-z0-9_.:\[\]-]+$/u))return undefined;
  if(secret&&(value.includes(secret)||value.length>=8&&secret.includes(value))||/^(?:sk-|Bearer|eyJ[^.]+\.)/iu.test(value)||/^\d{7,15}$/u.test(value))return undefined;
  return value;
}

function headerId(headers,secret){
  for(const name of ['x-request-id','request-id','x-requestid','x-amzn-requestid','x-ms-request-id','x-tt-logid']){
    const id=identifier(headers?.get?.(name),secret);
    if(id)return id;
  }
  return undefined;
}

export function assistantProviderDiagnostic(value,headers,secret){
  const error=record(value?.error)?value.error:record(value)?value:{};
  const message=typeof error.message==='string'?error.message:'';
  const embedded=/\b(?:request_id|request[ -]id)\s*[:=]\s*([A-Za-z0-9_.:-]{1,128})/iu.exec(message)?.[1];
  return {param:typeof error.param==='string'?error.param:'',message:message.toLowerCase(),
    code:identifier(error.code,secret,80),type:identifier(error.type,secret,80),
    requestId:headerId(headers,secret)||identifier(error.request_id,secret)||identifier(value?.request_id,secret)||identifier(embedded,secret)};
}

export async function readAssistantProviderDiagnostic(response,secret){
  let payload;
  if(response.body){
    const reader=response.body.getReader(),parts=[];let size=0;
    try{
      for(;;){
        const {done,value}=await reader.read();if(done)break;
        size+=value.length;if(size>32768)break;parts.push(value);
      }
      if(size<=32768)try{payload=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{}
    }catch{/* The HTTP status/header ID remain useful if the error body cannot be read. */}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  return assistantProviderDiagnostic(payload,response.headers,secret);
}

function diagnostic(context,extra={}){
  const secret=context.secret;
  const value={provider:identifier(context.provider,secret,32),model_id:identifier(context.modelId,secret,200),
    request_id:identifier(context.requestId,secret),phase:identifier(extra.phase||context.phase||'provider_http',secret,40)};
  const status=extra.status??context.status;
  if(Number.isInteger(status)&&status>=100&&status<=599)value.upstream_http_status=status;
  for(const [key,raw] of Object.entries({upstream_request_id:extra.upstreamRequestId||context.upstreamRequestId,
    provider_error_code:extra.code,provider_error_type:extra.type,parameter:extra.param,transport_code:extra.transportCode,exception_type:extra.exceptionType})){
    const safe=identifier(raw,secret,key==='parameter'?80:128);if(safe)value[key]=safe;
  }
  value.retryable=extra.retryable===true;
  return Object.fromEntries(Object.entries(value).filter(([,entry])=>entry!==undefined));
}

function publicMessage(reason,data){
  const facts=[];
  if(data.upstream_http_status)facts.push(`${data.phase==='provider_stream'&&data.upstream_http_status===200?'流连接HTTP':'上游HTTP'} ${data.upstream_http_status}`);
  if(data.provider_error_code)facts.push(`错误码 ${data.provider_error_code}`);
  const id=data.upstream_request_id||data.request_id;
  return reason+(facts.length?`（${facts.join('，')}）`:'')+
    (id?`。${data.upstream_request_id?'供应商请求编号':'本次请求编号'}：${id}`:'');
}

function failure(statusCode,code,reason,context,extra){
  const data=diagnostic(context,extra);
  return new ApiError(statusCode,code,publicMessage(reason,data),{assistantDiagnostic:data});
}

/** The reason is selected from observed status/code, never from a guessed provider balance. */
export function assistantProviderError(status,info={},context={}){
  const name=names[context.provider]||'模型供应商';
  const codeAndType=`${info.code||''} ${info.type||''}`.toLowerCase();
  const message=info.message||'';
  let http=502,code='MODEL_UPSTREAM_FAILED',reason=`${name}返回了尚未分类的接口错误`,retryable=status>=500;
  if(/context_length_exceeded|context_window_exceeded|input_tokens_exceeded/u.test(codeAndType)||
    /(?:context (?:length|window).*(?:exceed|too|maximum)|exceed.*context (?:length|window))/u.test(message)){
    http=422;code='MODEL_CONTEXT_EXCEEDED';reason=`${name}拒绝请求：上下文超过该模型的容量`;retryable=false;
  }else if(status===401||/invalid_api_key|authentication_error|authentication_failed/u.test(codeAndType)){
    http=503;code='MODEL_AUTH_UNAVAILABLE';reason=`${name}接口鉴权失败，请管理员检查后台模型凭据`;retryable=false;
  }else if(status===403||/permission_denied|access_denied/u.test(codeAndType)){
    http=503;code='MODEL_ACCESS_DENIED';reason=`${name}拒绝访问，请管理员核对凭据权限及供应商访问策略`;retryable=false;
  }else if(status===402||/insufficient_balance|insufficient_quota|credit_exhausted/u.test(codeAndType)){
    http=422;code='MODEL_BALANCE_OR_QUOTA_UNAVAILABLE';
    reason=context.provider==='deepseek'&&status===402||/insufficient_balance/u.test(codeAndType)
      ?`${name}账户余额不足，请检查供应商账户余额`
      :/insufficient_quota|credit_exhausted/u.test(codeAndType)?`${name}返回可用调用额度不足，请检查供应商账户配额`
      :`${name}要求处理账户付费状态，请核对供应商账户`;retryable=false;
  }else if(status===404||/model_not_found|unknown_model/u.test(codeAndType)){
    http=422;code='MODEL_NOT_FOUND';reason=`${name}未找到请求的模型或接口地址`;retryable=false;
  }else if(status===429||/rate_limit|rate_limited|too_many_requests/u.test(codeAndType)){
    http=429;code='MODEL_RATE_LIMITED';reason=`${name}限制了本次请求频率或并发，请按供应商限制稍后重试`;retryable=true;
  }else if(status===408||status===504){
    http=504;code='MODEL_UPSTREAM_TIMEOUT';reason=`${name}或其上游网关返回响应超时`;retryable=true;
  }else if(status===413){
    http=422;code='MODEL_REQUEST_TOO_LARGE';reason=`${name}拒绝请求：发送内容超过接口大小限制`;retryable=false;
  }else if(status===405||status===415){
    http=422;code='MODEL_PROTOCOL_REJECTED';retryable=false;
    reason=status===405?`${name}接口不接受本次请求方法，请核对API地址和协议`:`${name}接口不接受本次请求的内容类型，请核对API协议`;
  }else if(status===503||/overload|service_unavailable|server_busy/u.test(codeAndType)){
    http=503;code='MODEL_SERVICE_BUSY';reason=`${name}服务暂时不可用，请稍后重试或切换模型服务`;retryable=true;
    if(context.provider==='deepseek'&&status===503||/too busy|overload|server.*busy/u.test(message))reason=`${name}服务繁忙，请稍后重试或切换模型服务`;
  }else if(status===500){
    http=502;code='MODEL_PROVIDER_INTERNAL_ERROR';reason=`${name}服务内部发生错误，请稍后重试`;retryable=true;
  }else if(status===502){
    http=502;code='MODEL_UPSTREAM_GATEWAY_ERROR';reason=`${name}的上游网关返回错误，请稍后重试`;retryable=true;
  }else if([400,422].includes(status)){
    http=422;code='MODEL_REQUEST_REJECTED';reason=`${name}拒绝了本次请求参数`;retryable=false;
    const parameter=identifier(info.param,context.secret,80);
    if(parameter)reason+=` ${parameter}`;
    if(['thinking','thinking.type','thinking.clear_thinking','enable_thinking','reasoning_effort','reasoning_split'].includes(info.param)){
      code='THINKING_PARAMETER_REJECTED';reason=`${name}拒绝当前思考参数 ${info.param}，请核对实际型号的支持情况`;
    }else if(message.includes('reasoning_content')){
      code='MODEL_REASONING_HISTORY_REJECTED';reason=`${name}未接受原生思考历史，请核对该型号的工具历史要求`;
    }else if(info.param==='tool_choice'||message.includes('tool_choice')){
      code='MODEL_TOOL_CHOICE_REJECTED';reason=`${name}拒绝本次工具选择策略，请核对 tool_choice 要求`;
    }else if(/^tools(?:\[|\.|$)/u.test(info.param||'')&&/schema|parameters|properties|required|keyword/u.test(message)){
      code='MODEL_TOOL_SCHEMA_REJECTED';reason=`${name}未接受本次工具定义，请核对函数Schema`;
    }else if(/unsupported|not support|not available|does not support/u.test(message)){
      if(/tool|function/u.test(info.param+' '+message)){code='MODEL_TOOLS_UNSUPPORTED';reason=`${name}接口未接受本次工具调用配置，请核对当前通道及工具参数`;}
      else if(/image|vision/u.test(info.param+' '+message)){code='MODEL_IMAGE_UNSUPPORTED';reason=`${name}接口未接受本次图片输入，请核对型号、图片格式及输入方式`;}
      else{code='MODEL_CAPABILITY_UNSUPPORTED';reason=`${name}接口明确不支持本次请求能力`;}
    }
  }else if(context.phase==='provider_stream'){
    code='MODEL_PROVIDER_STREAM_ERROR';reason=`${name}在输出流中报告错误，本次输出未完整结束`;
  }
  return failure(http,code,reason,context,{status,code:info.code,type:info.type,param:info.param,
    upstreamRequestId:info.requestId,phase:context.phase,retryable});
}

export function assistantTransportError(error,context,timedOut=false){
  const name=names[context.provider]||'模型供应商';
  const transport=identifier(error?.cause?.code||error?.code,context.secret,80);
  const exceptionType=identifier(error?.name,context.secret,64);
  let http=502,code='MODEL_NETWORK_ERROR',reason=`后台连接${name}失败，未取得完整的接口响应`;
  if(timedOut){http=504;code='MODEL_TIMEOUT';reason=`后台等待${name}超过本次${context.timeoutSeconds}秒请求时限，连接已取消`;}
  else if(['ENOTFOUND','EAI_AGAIN'].includes(transport)){code='MODEL_DNS_FAILED';reason=`后台无法解析${name}的接口域名`;}
  else if(['CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(transport)){
    code='MODEL_TLS_FAILED';reason=`后台与${name}建立HTTPS连接时证书校验失败`;
  }else if(['ECONNRESET','ECONNREFUSED','EPIPE','UND_ERR_SOCKET'].includes(transport)){
    code='MODEL_CONNECTION_FAILED';reason=`后台与${name}的连接被拒绝或中断`;
  }else if(['ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(transport)){
    http=504;code='MODEL_NETWORK_TIMEOUT';reason=`后台连接${name}或读取响应时发生网络超时`;
  }
  if(!timedOut&&!transport&&exceptionType){code='MODEL_REQUEST_EXCEPTION';reason=`后台请求或处理${name}响应时出现 ${exceptionType}，原始错误未提供更具体的原因`;}
  return failure(http,code,reason,context,{phase:context.phase||(context.status?'provider_response':'transport'),transportCode:transport,exceptionType,retryable:true});
}

export function assistantErrorDiagnostic(error){
  const source=error instanceof ApiError?error.details?.assistantDiagnostic:null;
  if(!record(source))return undefined;
  return Object.fromEntries(Object.entries(source).filter(([key,value])=>diagnosticFields.has(key)&&
    (typeof value==='string'||typeof value==='boolean'||Number.isInteger(value))));
}

/** Backend failures have their own generated correlation ID; no client header/body is logged. */
export function assistantBackendDiagnostic(error,{phase='backend_http',status,code}={}){
  const exceptionType=error instanceof ApiError?'ApiError':error instanceof TypeError?'TypeError':
    error instanceof SyntaxError?'SyntaxError':error instanceof RangeError?'RangeError':'Error';
  const data={request_id:`assistant_error_${randomUUID()}`,phase,exception_type:exceptionType,
    retryable:status===429||!(error instanceof ApiError)&&status>=500};
  if(Number.isInteger(status)&&status>=100&&status<=599)data.backend_http_status=status;
  let locations=[];
  try{
    if(error instanceof Error&&typeof error.stack==='string'&&typeof error.name==='string'&&typeof error.message==='string'){
      const prefix=error.message?`${error.name}: ${error.message}`:error.name;
      // Remove the complete (possibly multiline) message before reading real stack frames.
      const frames=error.stack.startsWith(prefix)?error.stack.slice(prefix.length):'';
      locations=frames.split('\n').filter(line=>/^\s*at\s/u.test(line)).map(line=>
        /([A-Za-z0-9_.-]{1,80}\.(?:js|mjs|cjs|ts)):(\d+):(\d+)\)?$/u.exec(line)?.slice(1).join(':')).filter(Boolean).slice(0,3);
    }
  }catch{/* Correlation metadata remains usable if a foreign exception has no trustworthy stack. */}
  console.warn(JSON.stringify({event:'assistant_backend_failure',error_code:identifier(code,undefined,80)||'BACKEND_ERROR',
    ...data,...(locations.length?{stack_locations:locations}:{})}));
  return data;
}

export function reportAssistantFailure(error,context){
  if(!(error instanceof ApiError))return error;
  const data=assistantErrorDiagnostic(error)||diagnostic(context,{retryable:error.statusCode===429||error.statusCode>=500});
  const safeMessage=String(error.message).split(context.secret||'\u0000').join('[密钥已隐藏]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/giu,'Bearer [已隐藏]').replace(/\bsk-[A-Za-z0-9_-]+/gu,'[密钥已隐藏]');
  const result=new ApiError(error.statusCode,error.code,assistantErrorDiagnostic(error)?safeMessage:publicMessage(safeMessage,data),
    {...error.details,assistantDiagnostic:data});
  // This narrow structured event still works when the application's general logger is off.
  console.warn(JSON.stringify({event:'assistant_model_failure',error_code:error.code,...data}));
  return result;
}
