import {createHash,createHmac,randomBytes} from 'node:crypto';
import {ApiError} from './security.js';
import {assistantProviderError,assistantProviderDiagnostic,readAssistantProviderDiagnostic,assistantTransportError} from './assistant-provider-errors.js';
import {prepareCozeAssistant,cozeAssistantJsonResult,COZE_ASSISTANT_PROTOCOL} from './assistant-json-planner.js';
import {assistantTurnResult,assistantResult} from './assistant-protocol.js';

export const COZE_ASSISTANT_PATH='/internal/assistant-completion';
const PROJECT_ID='7689833705046130729',LIMIT=1536*1024;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const failure=(code,message)=>new ApiError(502,code,message);
const cancelled=()=>new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消，未继续执行工具');

/** The same verified Coze gateway/identity as the SDK, isolated from search/test/extract. */
export async function cozeGatewayAssistant(context,model,input,signal,{onReasoning=async()=>{},onConfiguration=async()=>{}}={}){
  const prepared=prepareCozeAssistant(model,input),{request,body}=prepared;
  const url=new URL(context.baseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof context.key!=='string'||context.key.length<8)
    throw failure('COZE_ASSISTANT_CONFIGURATION_INVALID','Coze对话网关身份无效');
  const deadline=AbortSignal.timeout(request.timeoutSeconds*1000),combined=AbortSignal.any([signal,deadline]);
  const diagnostic={provider:'coze',modelId:model.modelId,requestId:request.requestId,secret:context.key,timeoutSeconds:request.timeoutSeconds};
  const check=()=>{if(signal.aborted)throw cancelled();if(deadline.aborted)throw failure('MODEL_REQUEST_TIMEOUT','Coze模型响应超时');};
  let reader;
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
      rejection=await readAssistantProviderDiagnostic(response,context.key);
      const {param='',message=''}=rejection;
      if(body.max_tokens!==undefined&&(param==='max_tokens'||message.includes('max_completion_tokens'))){body.max_completion_tokens=body.max_tokens;delete body.max_tokens;}
      else if(body.stream&&(param==='stream'||message.includes('stream'))&&/unsupported|not support|not available/u.test(message))body.stream=false;
      else break;
      check();response=await send();rejection=undefined;
    }
    diagnostic.status=response.status;
    if(!response.ok)throw assistantProviderError(response.status,rejection??await readAssistantProviderDiagnostic(response,context.key),diagnostic);
    if(!response.body)throw failure('MODEL_RESPONSE_EMPTY','Coze模型没有返回内容');
    const configuration={...prepared.configuration,request_state:'provider_http_accepted',parameters:Object.fromEntries(
      ['thinking','max_tokens','max_completion_tokens'].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]))};
    check();await onConfiguration(configuration);
    reader=response.body.getReader();
    const decoder=new TextDecoder('utf-8',{fatal:true});
    let bytes=0,buffer='',content='',reasoning='',heldReasoning='',reasoningSeen=false,finish='',ended=false;
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
      if(message.content!==undefined&&message.content!==null){
        if(typeof message.content!=='string')throw failure('MODEL_RESPONSE_INVALID','Coze规划正文格式无效');
        content+=message.content;
      }
      if(message.reasoning_content!==undefined&&message.reasoning_content!==null)await emitReasoning(message.reasoning_content);
      if(message.tool_calls!==undefined&&message.tool_calls!==null&&(!Array.isArray(message.tool_calls)||message.tool_calls.length))
        throw failure('MODEL_JSON_PLAN_INVALID','Coze没有遵循已选择的JSON规划协议，未执行工具');
    };
    const frame=async raw=>{
      const data=raw.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!data)return;
      if(ended)throw failure('MODEL_STREAM_INCOMPLETE','Coze流结束后仍返回内容');
      if(data==='[DONE]'){ended=true;return;}
      let event;try{event=JSON.parse(data);}catch{throw failure('MODEL_STREAM_JSON_INVALID','Coze流式事件不是完整JSON');}
      if(!record(event))throw failure('MODEL_RESPONSE_INVALID','Coze流式事件结构无效');
      if(event.error)throw assistantProviderError(response.status,assistantProviderDiagnostic(event,response.headers,context.key),
        {...diagnostic,phase:'provider_stream'});
      if(!Array.isArray(event.choices)||event.choices.length>1)throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选');
      if(!event.choices.length)return;
      if(finish)throw failure('MODEL_STREAM_INCOMPLETE','Coze在终态后继续输出');
      const choice=event.choices[0];await takeMessage(choice.delta??{});
      if(choice.finish_reason!==undefined&&choice.finish_reason!==null)finish=choice.finish_reason;
    };
    const streaming=response.headers.get('content-type')?.includes('text/event-stream');
    while(!ended){
      check();const {done,value}=await reader.read();if(done)break;
      bytes+=value.length;if(bytes>LIMIT)throw failure('MODEL_RESPONSE_TOO_LARGE','Coze响应超过处理范围，未截断或执行');
      buffer+=decoder.decode(value,{stream:true});
      if(streaming){let boundary;while(!ended&&(boundary=/\r?\n\r?\n/u.exec(buffer))!==null){const raw=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);await frame(raw);}}
    }
    buffer+=decoder.decode();
    if(streaming){if(!ended&&buffer.trim())await frame(buffer);if(!ended)throw failure('MODEL_STREAM_INCOMPLETE','Coze响应未完整结束，未执行工具');}
    else{
      let value;try{value=JSON.parse(buffer);}catch{throw failure('MODEL_RESPONSE_JSON_INVALID','Coze响应不是有效JSON');}
      if(!record(value))throw failure('MODEL_RESPONSE_INVALID','Coze响应结构无效');
      if(!Array.isArray(value.choices)||value.choices.length!==1)throw failure('MODEL_RESPONSE_INVALID','Coze返回了无效候选');
      finish=value.choices[0].finish_reason;await takeMessage(value.choices[0].message);
    }
    if(finish!=='stop')throw failure(finish==='length'?'MODEL_OUTPUT_TRUNCATED':'MODEL_STREAM_INCOMPLETE','Coze规划没有完整结束，未执行工具');
    if(content.includes(context.key))throw failure('MODEL_RESPONSE_SENSITIVE','模型响应包含不应公开的服务信息');
    check();
    const result=cozeAssistantJsonResult(content,request,reasoningSeen?reasoning:undefined);
    if(heldReasoning){check();await onReasoning(heldReasoning);}
    check();
    return {...result,configuration};
  }catch(error){
    if(signal.aborted)throw cancelled();
    throw error instanceof ApiError?error:assistantTransportError(error,diagnostic,deadline.aborted);
  }finally{if(reader){await reader.cancel().catch(()=>{});reader.releaseLock();}}
}

/** HMAC bridge for an account server outside Coze. The native in-process path uses the same planner. */
export function remoteCozeAssistant(bridge){
  return async(model,input,signal,onText=async()=>{},onReasoning=async()=>{},onConfiguration=async()=>{})=>{
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
    let bytes=0,buffer='',envelope,result,reasoning='',reasoningSeen=false,configurationSeen=false,ended=false;
    const accept=async value=>{
      check();
      if(!record(value))throw failure('MODEL_RESPONSE_INVALID','Coze桥接事件结构无效');
      if(value.error){
        const code=typeof value.error.code==='string'&&/^[A-Z0-9_]{1,80}$/u.test(value.error.code)?value.error.code:'COZE_ASSISTANT_UNAVAILABLE';
        const message=typeof value.error.message==='string'&&value.error.message.length<=600&&!value.error.message.includes(bridge.key)?value.error.message:'Coze对话执行失败';
        throw new ApiError(response.ok?502:response.status,code,message);
      }
      if(!envelope){
        if(value.projectId!==PROJECT_ID||value.environment!==bridge.environment||value.requestId!==request.requestId||value.planningProtocol!==COZE_ASSISTANT_PROTOCOL)
          throw failure('COZE_ASSISTANT_IDENTITY_INVALID','Coze对话桥接项目、请求或协议不一致');
        envelope=true;
      }
      if(value.configuration){configurationSeen=true;await onConfiguration(value.configuration);}
      if(value.reasoning_content!==undefined){
        if(typeof value.reasoning_content!=='string')throw failure('MODEL_REASONING_INVALID','桥接推理字段格式无效');
        reasoningSeen=true;reasoning+=value.reasoning_content;if(reasoning.length>512*1024)throw failure('MODEL_RESPONSE_TOO_LARGE','桥接推理内容超出处理范围');
        await onReasoning(value.reasoning_content);
      }
      if(value.result!==undefined){if(result)throw failure('MODEL_RESPONSE_INVALID','Coze返回重复结果');result=value.result;}
    };
    try{
      const streaming=response.headers.get('content-type')?.includes('text/event-stream');
      while(!ended){
        check();
        const {done,value}=await reader.read();if(done)break;bytes+=value.length;
        if(bytes>LIMIT)throw failure('MODEL_RESPONSE_TOO_LARGE','Coze桥接响应过大，未截断');
        buffer+=decoder.decode(value,{stream:true});
        if(streaming){let boundary;while((boundary=/\r?\n\r?\n/u.exec(buffer))!==null){
          const frame=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length);
          const data=frame.split(/\r?\n/u).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
          if(data==='[DONE]'){ended=true;break;}if(data)await accept(JSON.parse(data));
        }}
      }
      buffer+=decoder.decode();
      if(!streaming){await accept(JSON.parse(buffer));ended=true;}
      check();
      if(!ended||!result||!envelope)throw failure('MODEL_STREAM_INCOMPLETE','Coze桥接未完整返回工具决定');
      if(!record(result)||!Array.isArray(result.choices)||result.choices.length!==1||!record(result.choices[0].message))throw failure('MODEL_RESPONSE_INVALID','Coze桥接结果结构无效');
      if(reasoningSeen)result.choices[0].message.reasoning_content=reasoning;
      const normalized=request.mode==='chat'?assistantTurnResult(result,request.tools,{recoverInvalidTools:false}):assistantResult(result,request.tools);
      if(!record(result.configuration)||result.configuration.planning_protocol!==COZE_ASSISTANT_PROTOCOL)
        throw failure('MODEL_CONFIGURATION_UNCONFIRMED','Coze桥接未确认本轮JSON规划协议');
      if(!configurationSeen)await onConfiguration(result.configuration);
      const message=normalized.choices[0].message;
      if(!reasoningSeen&&message.reasoning_content)await onReasoning(message.reasoning_content);
      if(message.content)await onText(message.content);
      check();
      return {...normalized,configuration:result.configuration,planningProtocol:COZE_ASSISTANT_PROTOCOL,toolCallIdSource:'adapter'};
    }catch(error){
      if(signal.aborted)throw cancelled();
      if(combined.aborted)throw failure('MODEL_REQUEST_TIMEOUT','Coze对话桥接响应超时，未继续执行工具');
      if(error instanceof ApiError)throw error;
      if(error instanceof SyntaxError)throw failure('MODEL_STREAM_JSON_INVALID','Coze桥接响应不是有效JSON，未执行工具');
      throw failure('MODEL_NETWORK_ERROR','读取Coze对话桥接响应失败，请重试');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  };
}
