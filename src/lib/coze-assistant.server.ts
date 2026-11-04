import {HeaderUtils} from 'coze-coding-dev-sdk';
import {ApiError} from '../../question-bank/server/src/security.js';
import {prepareCozeAssistant,COZE_ASSISTANT_PROTOCOL} from '../../question-bank/server/src/assistant-json-planner.js';
import type {CozeAssistantBinding} from '../../question-bank/server/src/assistant-json-planner.js';
import {cozeGatewayAssistant} from '../../question-bank/server/src/coze-assistant-transport.js';
import type {CozeAssistantEmit,CozeAssistantConfigure,CozeAssistantUsage} from '../../question-bank/server/src/coze-assistant-transport.js';
import {cozeAssistantRuntime,readAuthenticatedAssistantBody,denyModelCompletion} from './coze-llm.server';

const PROJECT_ID='7689833705046130729';
const HEADERS={'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'};
const record=(value: unknown): value is Record<string,unknown> => value!==null&&typeof value==='object'&&!Array.isArray(value);
let active=0;

function binding(value: unknown): CozeAssistantBinding {
  if(!record(value)||Object.keys(value).some(key=>!['execution','provider','modelId'].includes(key))||value.execution!=='coze'||
    typeof value.provider!=='string'||typeof value.modelId!=='string')
    throw new ApiError(400,'COZE_ASSISTANT_CONFIGURATION_INVALID','Coze对话绑定格式无效');
  return {execution:'coze',provider:value.provider,modelId:value.modelId};
}

function safeFailure(error: unknown): {status: number; code: string; message: string} {
  if(error instanceof ApiError&&record(error)&&typeof error.statusCode==='number'&&typeof error.code==='string')
    return {status:error.statusCode,code:error.code,message:error.message};
  if(record(error)&&typeof error.status==='number'&&typeof error.code==='string'&&typeof error.publicMessage==='string')
    return {status:error.status,code:error.code,message:error.publicMessage};
  return {status:502,code:'COZE_ASSISTANT_UNAVAILABLE',message:'Coze对话桥接执行失败，请重试或检查后台记录'};
}

/** All phone/file execution stays in App. This process returns one validated decision. */
export async function cozeProjectAssistantCompletion(model: unknown, input: unknown, execution: {
  signal: AbortSignal; headers?: Headers | Record<string,string>;
  onReasoning?: CozeAssistantEmit; onConfiguration?: CozeAssistantConfigure; onUsage?: CozeAssistantUsage;
}): Promise<Record<string,unknown>> {
  const config=binding(model),prepared=prepareCozeAssistant(config,input);
  const signal=AbortSignal.any([execution.signal,AbortSignal.timeout(prepared.request.timeoutSeconds*1000)]);
  if(active>=4)throw new ApiError(429,'ASSISTANT_BUSY','Coze对话已有请求处理中，请稍后重试');
  active++;
  try{
    const runtime=await cozeAssistantRuntime(config.modelId,Date.now()+prepared.request.timeoutSeconds*1000,signal);
    if((prepared.request.image||prepared.request.visionEnabled)&&!runtime.supportsImages)
      throw new ApiError(422,'MODEL_IMAGE_UNSUPPORTED','当前Coze实际型号不支持本次图片或截图，未执行任务');
    const headers=runtime.config.getHeaders(HeaderUtils.extractForwardHeaders(execution.headers??new Headers()));
    const result=await cozeGatewayAssistant({baseUrl:runtime.config.modelBaseUrl,key:runtime.config.apiKey,headers},config,input,signal,
      {onReasoning:execution.onReasoning,onConfiguration:execution.onConfiguration,onUsage:execution.onUsage});
    if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消，未返回工具决定');
    return result;
  }finally{active--;}
}

export async function assistantCompletion(request: Request): Promise<Response> {
  try{
    const raw=await readAuthenticatedAssistantBody(request);
    if(raw===null)return denyModelCompletion();
    let value: unknown;
    try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}
    catch{throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','对话桥接请求不是有效JSON');}
    if(!record(value)||Object.keys(value).some(key=>!['model','request'].includes(key)))
      throw new ApiError(400,'ASSISTANT_REQUEST_INVALID','对话桥接请求格式无效');
    const model=binding(value.model),input: unknown=value.request,prepared=prepareCozeAssistant(model,input);
    const requestSignal=AbortSignal.any([request.signal,AbortSignal.timeout(prepared.request.timeoutSeconds*1000)]);
    // Establish the real project/phase before sending a public SSE frame.
    const context=await cozeAssistantRuntime(model.modelId,Date.now()+prepared.request.timeoutSeconds*1000,requestSignal);
    const envelope={projectId:PROJECT_ID,environment:context.environment,requestId:prepared.request.requestId,planningProtocol:COZE_ASSISTANT_PROTOCOL};
    if(!request.headers.get('accept')?.includes('text/event-stream')){
      const result=await cozeProjectAssistantCompletion(model,input,{signal:requestSignal,headers:request.headers});
      return new Response(JSON.stringify({...envelope,result}),{headers:HEADERS});
    }
    const controller=new AbortController(),signal=AbortSignal.any([requestSignal,controller.signal]);
    const encoder=new TextEncoder();
    const stream=new ReadableStream<Uint8Array>({
      start(output){
        const event=(payload: Record<string,unknown>): Promise<void>=>{
          if(signal.aborted)return Promise.reject(new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消'));
          output.enqueue(encoder.encode('data: '+JSON.stringify(payload)+'\n\n'));return Promise.resolve();
        };
        void (async()=>{
          try{
            await event(envelope);
            const result=await cozeProjectAssistantCompletion(model,input,{signal,headers:request.headers,
              onReasoning:text=>event({reasoning_content:text}),onConfiguration:configuration=>event({configuration}),
              onUsage:(usage,metadata)=>event({usage,usage_metadata:metadata})});
            // Reasoning was already sent incrementally; do not duplicate a large field in the terminal frame.
            const choices=result.choices;
            if(Array.isArray(choices)&&record(choices[0])&&record(choices[0].message))delete choices[0].message.reasoning_content;
            await event({result});
            output.enqueue(encoder.encode('data: [DONE]\n\n'));output.close();
          }catch(error: unknown){
            if(signal.aborted){try{output.error(new Error('Coze对话已取消'));}catch{controller.abort();}}
            else{const failure=safeFailure(error);try{await event({error:{code:failure.code,message:failure.message}});output.close();}catch{controller.abort();}}
          }
        })();
      },cancel(){controller.abort();},
    });
    return new Response(stream,{headers:{...HEADERS,'content-type':'text/event-stream; charset=utf-8','x-accel-buffering':'no'}});
  }catch(error: unknown){
    const failure=safeFailure(error);
    return new Response(JSON.stringify({error:{code:failure.code,message:failure.message}}),{status:failure.status,headers:HEADERS});
  }
}
