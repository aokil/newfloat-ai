import {createHash,createHmac,randomBytes} from 'node:crypto';
import {ApiError} from './security.js';
import {assistantProviderError,assistantProviderDiagnostic,readAssistantProviderDiagnostic,assistantTransportError,reportAssistantFailure} from './assistant-provider-errors.js';
import {prepareCozeAssistant,cozeAssistantJsonResult,COZE_ASSISTANT_PROTOCOL} from './assistant-json-planner.js';
import {assistantTurnResult,assistantResult} from './assistant-protocol.js';

export const COZE_ASSISTANT_PATH='/internal/assistant-completion';
const PROJECT_ID='7689833705046130729',LIMIT=1536*1024;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(code,message)=>new ApiError(502,code,message);
const cancelled=()=>new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消，未继续执行工具');

/** Incremental SSE framing: LF, CRLF (including split chunks), CR, comments and EOF tails. */
function sseData(consume){
  let buffer='',data=[];
  const line=async value=>{
    if(value===''){
      if(data.length){const payload=data.join('\n');data=[];await consume(payload);}
      return;
    }
    const colon=value.indexOf(':'),field=colon<0?value:value.slice(0,colon);
    let content=colon<0?'':value.slice(colon+1);
    if(content.startsWith(' '))content=content.slice(1);
    if(field==='data')data.push(content);
  };
  return async(text,eof=false)=>{
    buffer+=text;
    let boundary;
    while((boundary=/\r\n|\r|\n/u.exec(buffer))!==null){
      // A trailing CR may be the first half of a CRLF in the next byte chunk.
      if(!eof&&boundary[0]==='\r'&&boundary.index===buffer.length-1)break;
      const value=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
      await line(value);
    }
    if(eof){if(buffer){const value=buffer;buffer='';await line(value);}await line('');}
  };
}

function decodeResponse(decoder,value){
  try{return value===undefined?decoder.decode():decoder.decode(value,{stream:true});}
  catch{throw failure('MODEL_RESPONSE_ENCODING_INVALID','Coze响应包含无效或截断的UTF-8字符，未交付结果或执行工具');}
}

function requireNormalFinish(finish,content,reasoning){
  if(finish==='length')throw failure('MODEL_OUTPUT_TRUNCATED','Coze回复因输出长度限制被截断，尚未形成完整结果；未执行工具');
  if(finish==='content_filter')throw failure('MODEL_OUTPUT_BLOCKED','Coze模型服务因内容审核中止了回复，未返回完整结果或执行工具');
  if(finish==='tool_calls'||finish==='function_call')throw failure('MODEL_JSON_PLAN_INVALID','Coze返回了原生工具结束状态，与当前JSON规划协议不一致；未执行工具');
  if(finish&&finish!=='stop')throw failure('MODEL_STREAM_INCOMPLETE','Coze返回了当前接入尚未支持的结束状态，未确认完整结果或执行工具');
  if(!finish)throw failure('MODEL_STREAM_INCOMPLETE',reasoning&&!content.trim()?
    'Coze只返回了思考内容，未返回正式回复或操作指令及正常结束状态；未执行工具':
    'Coze回复已停止传输，但未收到模型的正常结束状态；未将内容认作完整结果或执行工具');
  if(!content.trim())throw failure('MODEL_RESPONSE_EMPTY',reasoning?
    'Coze已报告结束，但只返回了思考内容，缺少正式回复或操作指令；未执行工具':
    'Coze已报告结束，但没有返回正式回复或操作指令；未执行工具');
}

/** The same verified Coze gateway/identity as the SDK, isolated from search/test/extract. */
export async function cozeGatewayAssistant(context,model,input,signal,{onReasoning=async()=>{},onConfiguration=async()=>{},onUsage=async()=>{}}={}){
  let usageObserved=false;
  const observeUsage=async(value,metadata)=>{usageObserved=true;await onUsage(value,metadata);};
  const prepared=prepareCozeAssistant(model,input),{request,body}=prepared;
  const url=new URL(context.baseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof context.key!=='string'||context.key.length<8)
    throw failure('COZE_ASSISTANT_CONFIGURATION_INVALID','Coze对话网关身份无效');
  const deadline=AbortSignal.timeout(request.timeoutSeconds*1000),combined=AbortSignal.any([signal,deadline]);
  const diagnostic={provider:'coze',modelId:model.modelId,requestId:request.requestId,secret:context.key,timeoutSeconds:request.timeoutSeconds};
  const check=()=>{if(signal.aborted)throw cancelled();if(deadline.aborted)throw failure('MODEL_REQUEST_TIMEOUT','Coze模型响应超时');};
  let reader,streaming=false,eof=false,ended=false,finish='',content='',reasoning='';
  try{
    check();
    const headers=new Headers(context.headers);
    // SDK.getHeaders already supplies Authorization and may add runtime identity headers.
    // Normalize once; two differently cased Authorization keys would be combined by fetch.
    if(!headers.has('authorization'))headers.set('authorization',`Bearer ${context.key}`);
    headers.set('content-type','application/json');headers.set('accept','text/event-stream, application/json');
    headers.set('cache-control','no-store');headers.set('x-client-sdk','float-ai-coze-json/1');
    const send=()=>fetch(url.toString().replace(/\/$/u,'')+'/chat/completions',{method:'POST',redirect:'error',signal:combined,
      headers,body:JSON.stringify(body)});
    let response=await send(),rejection;
    // Only documented compatibility errors are retried, before delivering any model output.
    for(let attempt=0;attempt<2&&[400,422].includes(response.status);attempt++){
      rejection=await readAssistantProviderDiagnostic(response,context.key,observeUsage);
      if(usageObserved)break;
      const {param='',message=''}=rejection;
      if(body.max_tokens!==undefined&&(param==='max_tokens'||message.includes('max_completion_tokens'))){body.max_completion_tokens=body.max_tokens;delete body.max_tokens;}
      else if(body.stream&&(param==='stream'||message.includes('stream'))&&/unsupported|not support|not available/u.test(message))body.stream=false;
      else break;
      check();response=await send();rejection=undefined;
    }
    diagnostic.status=response.status;
    if(!response.ok)throw assistantProviderError(response.status,rejection??await readAssistantProviderDiagnostic(response,context.key,observeUsage),diagnostic);
    if(!response.body)throw failure('MODEL_RESPONSE_EMPTY','Coze模型没有返回内容');
    const configuration={...prepared.configuration,request_state:'provider_http_accepted',parameters:Object.fromEntries(
      ['thinking','max_tokens','max_completion_tokens'].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]))};
    check();await onConfiguration(configuration);
    reader=response.body.getReader();
    const decoder=new TextDecoder('utf-8',{fatal:true});
    let bytes=0,buffer='',heldReasoning='',reasoningSeen=false,usage;
    const emitReasoning=async text=>{
      if(typeof text!=='string')throw failure('MODEL_REASONING_INVALID','Coze推理字段格式无效');
      reasoningSeen=true;reasoning+=text;heldReasoning+=text;
      if(reasoning.length>512*1024)throw failure('MODEL_RESPONSE_TOO_LARGE','Coze推理内容超出处理范围，未截断或执行');
      if(heldReasoning.includes(context.key))throw failure('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
      // Hold only a suffix that is actually a credential prefix, even for long workload tokens.
      let keep=Math.min(heldReasoning.length,context.key.length-1);
      while(keep>0&&!context.key.startsWith(heldReasoning.slice(-keep)))keep--;
      const safe=heldReasoning.length-keep;
      if(safe>0){check();await onReasoning(heldReasoning.slice(0,safe));heldReasoning=heldReasoning.slice(safe);}
    };
    const takeMessage=async message=>{
      if(!record(message))throw failure('MODEL_RESPONSE_INVALID','Coze消息结构无效');
      if(message.role!==undefined&&message.role!=='assistant')throw failure('MODEL_RESPONSE_INVALID','Coze响应角色无效');
      if(message.content!==undefined&&message.content!==null&&typeof message.content!=='string')throw failure('MODEL_RESPONSE_INVALID','Coze规划正文格式无效');
      if(message.reasoning_content!==undefined&&message.reasoning_content!==null&&typeof message.reasoning_content!=='string')throw failure('MODEL_REASONING_INVALID','Coze推理字段格式无效');
      if(finish&&(message.content||message.reasoning_content||message.tool_calls?.length))
        throw failure('MODEL_STREAM_INCOMPLETE','Coze在结束状态之后又返回了新的正文、思考或工具内容，未执行工具');
      if(message.content!==undefined&&message.content!==null){
        content+=message.content;
      }
      if(message.reasoning_content!==undefined&&message.reasoning_content!==null)await emitReasoning(message.reasoning_content);
      if(message.tool_calls!==undefined&&message.tool_calls!==null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length))
        throw failure('MODEL_JSON_PLAN_INVALID','Coze没有遵循已选择的JSON规划协议，未执行工具');
    };
    const setFinish=value=>{
      if(value===undefined||value===null||value==='')return;
      if(typeof value!=='string'||value.length>80)throw failure('MODEL_RESPONSE_INVALID','Coze返回的结束状态格式无效');
      if(finish&&finish!==value)throw failure('MODEL_STREAM_INCOMPLETE','Coze返回了互相矛盾的结束状态，未执行工具');
      finish=value;
    };
    const frame=async data=>{
      if(!data.trim())return;
      if(data.trim()==='[DONE]'){ended=true;return;}
      if(ended)throw failure('MODEL_STREAM_INCOMPLETE','Coze流结束后仍返回内容');
      let event;try{event=JSON.parse(data);}catch{throw failure('MODEL_STREAM_JSON_INVALID','Coze流式事件不是完整JSON');}
      if(!record(event))throw failure('MODEL_RESPONSE_INVALID','Coze流式事件结构无效');
      if(event.usage!==undefined&&event.usage!==null){usage=event.usage;await observeUsage(event.usage,{created:event.created});}
      if(event.error)throw assistantProviderError(response.status,assistantProviderDiagnostic(event,response.headers,context.key),
        {...diagnostic,phase:'provider_stream'});
      if(!Array.isArray(event.choices)||event.choices.length>1)throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选');
      if(!event.choices.length)return;
      const choice=event.choices[0];
      if(!record(choice)||choice.index!==undefined&&choice.index!==0)throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选编号');
      await takeMessage(choice.delta??{});setFinish(choice.finish_reason);
    };
    const frames=sseData(frame);
    streaming=response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')===true;
    diagnostic.phase=streaming?'provider_stream':'provider_response';
    while(!ended){
      check();const {done,value}=await reader.read();if(done){eof=true;break;}
      bytes+=value.length;if(bytes>LIMIT)throw failure('MODEL_RESPONSE_TOO_LARGE','Coze响应超过处理范围，未截断或执行');
      const text=decodeResponse(decoder,value);
      if(streaming)await frames(text);else buffer+=text;
    }
    const tail=decodeResponse(decoder);
    if(streaming){await frames(tail,true);if(!ended&&!eof)throw failure('MODEL_STREAM_INCOMPLETE','Coze流未确认正常关闭，未交付结果或执行工具');}
    else{
      buffer+=tail;
      let value;try{value=JSON.parse(buffer);}catch{throw failure('MODEL_RESPONSE_JSON_INVALID','Coze响应不是有效JSON');}
      if(!record(value))throw failure('MODEL_RESPONSE_INVALID','Coze响应结构无效');
      if(value.usage!==undefined&&value.usage!==null)await observeUsage(value.usage,{created:value.created});
      if(value.error)throw assistantProviderError(response.status,assistantProviderDiagnostic(value,response.headers,context.key),diagnostic);
      if(!Array.isArray(value.choices)||value.choices.length!==1)throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选');
      const choice=value.choices[0];if(!record(choice))throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选');
      await takeMessage(choice.message);setFinish(choice.finish_reason);usage=value.usage;
    }
    requireNormalFinish(finish,content,reasoning);
    if(content.includes(context.key))throw failure('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
    check();
    const result=cozeAssistantJsonResult(content,request,reasoningSeen?reasoning:undefined,usage);
    if(heldReasoning){check();await onReasoning(heldReasoning);}
    check();
    return {...result,configuration};
  }catch(error){
    if(signal.aborted)throw cancelled();
    const reported=error instanceof ApiError?error:assistantTransportError(error,diagnostic,deadline.aborted);
    throw reportAssistantFailure(reported,{...diagnostic,retryable:false,upstreamFinishReason:finish,
      ...(streaming?{streamDoneSeen:ended,streamEofSeen:eof}:{}),answerReceived:content.length>0,reasoningReceived:reasoning.length>0});
  }finally{if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
}

/** HMAC bridge for an account server outside Coze. The native in-process path uses the same planner. */
export function remoteCozeAssistant(bridge){
  return async(model,input,signal,onText=async()=>{},onReasoning=async()=>{},onConfiguration=async()=>{},onUsage=async()=>{})=>{
    if(!bridge)throw failure('COZE_INTEGRATION_NOT_READY','Coze对话桥接尚未配置');
    const {request}=prepareCozeAssistant(model,input);
    const raw=JSON.stringify({model:{execution:'coze',provider:model.provider,modelId:model.modelId},request:input});
    if(Buffer.byteLength(raw)>4*1024*1024)throw new ApiError(413,'ASSISTANT_REQUEST_TOO_LARGE','对话历史超过桥接处理范围，未截断');
    const timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),digest=createHash('sha256').update(raw).digest('hex');
    const signature=createHmac('sha256',bridge.key).update(`POST\n${COZE_ASSISTANT_PATH}\n${timestamp}\n${nonce}\n${digest}`).digest('hex');
    const combined=AbortSignal.any([signal,AbortSignal.timeout(request.timeoutSeconds*1000)]);
    const check=()=>{if(signal.aborted)throw cancelled();if(combined.aborted)throw failure('MODEL_REQUEST_TIMEOUT','Coze对话桥接响应超时');};
    let response;
    try{response=await fetch(bridge.origin+COZE_ASSISTANT_PATH,{method:'POST',redirect:'error',signal:combined,
      headers:{'content-type':'application/json',accept:'text/event-stream','x-float-llm-timestamp':timestamp,'x-float-llm-nonce':nonce,'x-float-llm-signature':signature},body:raw});}
    catch{if(signal.aborted)throw cancelled();throw failure(combined.aborted?'MODEL_REQUEST_TIMEOUT':'COZE_ASSISTANT_UNAVAILABLE','Coze对话桥接连接失败或超时');}
    if(!response.body)throw failure('MODEL_RESPONSE_EMPTY','Coze对话桥接未返回内容');
    const reader=response.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});
    let bytes=0,buffer='',envelope,result,reasoning='',reasoningSeen=false,configurationSeen=false,usageSeen=false,ended=false,eof=false;
    const streaming=response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')===true;
    const diagnostic={provider:'coze',modelId:model.modelId,requestId:request.requestId,secret:bridge.key,
      status:response.status,phase:streaming?'bridge_stream':'bridge_response'};
    const accept=async value=>{
      check();
      if(!record(value))throw failure('MODEL_RESPONSE_INVALID','Coze桥接事件结构无效');
      if(value.error){
        const code=typeof value.error.code==='string'&&/^[A-Z0-9_]{1,80}$/u.test(value.error.code)?value.error.code:'COZE_ASSISTANT_UNAVAILABLE';
        const message=typeof value.error.message==='string'&&value.error.message.length<=600&&!value.error.message.includes(bridge.key)?value.error.message:'Coze对话执行失败';
        throw new ApiError(response.ok?502:response.status,code,message);
      }
      if(result!==undefined)throw failure('MODEL_STREAM_INCOMPLETE','Coze桥接在完整结果之后又返回内容，未交付重复或冲突的结果');
      if(!envelope){
        if(value.projectId!==PROJECT_ID||value.environment!==bridge.environment||value.requestId!==request.requestId||value.planningProtocol!==COZE_ASSISTANT_PROTOCOL)
          throw failure('COZE_ASSISTANT_IDENTITY_INVALID','Coze对话桥接项目、请求或协议不一致');
        envelope=true;
      }
      if(value.usage!==undefined&&value.usage!==null){await onUsage(value.usage,record(value.usage_metadata)?value.usage_metadata:{});usageSeen=true;}
      if(!usageSeen&&record(value.result)&&value.result.usage!==undefined)await onUsage(value.result.usage);
      if(value.configuration){configurationSeen=true;check();await onConfiguration(value.configuration);check();}
      if(value.reasoning_content!==undefined){
        if(typeof value.reasoning_content!=='string')throw failure('MODEL_REASONING_INVALID','桥接推理字段格式无效');
        reasoningSeen=true;reasoning+=value.reasoning_content;if(reasoning.length>512*1024)throw failure('MODEL_RESPONSE_TOO_LARGE','桥接推理内容超出处理范围');
        check();await onReasoning(value.reasoning_content);check();
      }
      if(value.result!==undefined)result=value.result;
    };
    const frames=sseData(async data=>{
      if(!data.trim())return;
      if(data.trim()==='[DONE]'){ended=true;return;}
      if(ended)throw failure('MODEL_STREAM_INCOMPLETE','Coze桥接结束后仍返回内容');
      let value;try{value=JSON.parse(data);}catch{throw failure('MODEL_STREAM_JSON_INVALID','Coze桥接流包含不完整的JSON事件，未执行工具');}
      await accept(value);
    });
    try{
      while(!ended){
        check();
        const {done,value}=await reader.read();if(done){eof=true;break;}bytes+=value.length;
        if(bytes>LIMIT)throw failure('MODEL_RESPONSE_TOO_LARGE','Coze桥接响应过大，未截断');
        const text=decodeResponse(decoder,value);
        if(streaming)await frames(text);else buffer+=text;
      }
      const tail=decodeResponse(decoder);
      if(streaming)await frames(tail,true);else{buffer+=tail;await accept(JSON.parse(buffer));}
      check();
      if((!ended&&!eof)||result===undefined||!envelope)throw failure('MODEL_STREAM_INCOMPLETE',reasoning?
        'Coze桥接只返回了思考等增量内容，尚未收到完整正式回复或工具决定；未执行工具':
        'Coze桥接未完整返回正式回复或工具决定，未执行工具');
      if(!record(result)||!Array.isArray(result.choices)||result.choices.length!==1||!record(result.choices[0].message))throw failure('MODEL_RESPONSE_INVALID','Coze桥接结果结构无效');
      if(reasoningSeen)result.choices[0].message.reasoning_content=reasoning;
      const normalized=request.mode==='chat'?assistantTurnResult(result,request.tools,{recoverInvalidTools:false}):assistantResult(result,request.tools);
      if(!record(result.configuration)||result.configuration.planning_protocol!==COZE_ASSISTANT_PROTOCOL)
        throw failure('MODEL_CONFIGURATION_UNCONFIRMED','Coze桥接未确认本轮JSON规划协议');
      if(!configurationSeen){check();await onConfiguration(result.configuration);check();}
      const message=normalized.choices[0].message;
      if(!reasoningSeen&&message.reasoning_content){check();await onReasoning(message.reasoning_content);check();}
      if(message.content){check();await onText(message.content);check();}
      check();
      return {...normalized,configuration:result.configuration,planningProtocol:COZE_ASSISTANT_PROTOCOL,toolCallIdSource:'adapter'};
    }catch(error){
      if(signal.aborted)throw cancelled();
      const reported=combined.aborted?failure('MODEL_REQUEST_TIMEOUT','Coze对话桥接响应超时，未继续执行工具'):
        error instanceof ApiError?error:error instanceof SyntaxError?failure('MODEL_STREAM_JSON_INVALID','Coze桥接响应不是有效JSON，未执行工具'):
        failure('MODEL_NETWORK_ERROR','读取Coze对话桥接响应失败，未交付结果或执行工具');
      throw reportAssistantFailure(reported,{...diagnostic,retryable:false,upstreamFinishReason:result?.choices?.[0]?.finish_reason,
        ...(streaming?{streamDoneSeen:ended,streamEofSeen:eof}:{}),
        answerReceived:typeof result?.choices?.[0]?.message?.content==='string'&&result.choices[0].message.content.length>0,
        reasoningReceived:reasoning.length>0});
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  };
}
