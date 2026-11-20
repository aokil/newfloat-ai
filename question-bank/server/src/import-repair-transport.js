import {ApiError} from './security.js';
import {IMPORT_REPAIR_PROMPT,importRepairRequest} from './import-repair.js';

/** Single request on the existing verified Coze gateway. No SDK retry, tools, or search-answer parser. */
export async function cozeGatewayImportRepair(context,modelId,input,execution){
  const request=importRepairRequest(input),url=new URL(context.baseUrl);
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof context.key!=='string'||context.key.length<8)
    throw new ApiError(503,'IMPORT_REPAIR_CONFIGURATION_INVALID','Coze修正网关身份无效');
  if(execution.signal.aborted)throw new ApiError(499,'IMPORT_REPAIR_CANCELLED','请求在提交前已取消');
  const headers=new Headers(context.headers);if(!headers.has('authorization'))headers.set('authorization','Bearer '+context.key);
  headers.set('content-type','application/json');headers.set('accept','application/json');headers.set('cache-control','no-store');
  const body={model:modelId,messages:[{role:'system',content:IMPORT_REPAIR_PROMPT},{role:'user',content:JSON.stringify(request)}],
    stream:false,thinking:{type:'disabled'},temperature:0,max_tokens:8192};
  execution.onSubmitted();
  const response=await fetch(url.toString().replace(/\/$/u,'')+'/chat/completions',{method:'POST',redirect:'error',headers,body:JSON.stringify(body),signal:execution.signal});
  if(!response.ok){await response.body?.cancel();throw new ApiError(response.status===429?429:502,'IMPORT_REPAIR_PROVIDER_REJECTED','Coze模型未接受或完成修正请求，未自动重试');}
  if(!response.body)throw new ApiError(502,'IMPORT_REPAIR_RESPONSE_MISSING','Coze未返回修正内容');
  const reader=response.body.getReader(),chunks=[];let bytes=0;
  try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>256*1024)throw new ApiError(502,'IMPORT_REPAIR_RESPONSE_TOO_LARGE','修正回复超出范围');chunks.push(next.value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let raw;try{raw=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{throw new ApiError(502,'IMPORT_REPAIR_RESPONSE_INVALID','模型回复编码不完整');}
  if(raw.includes(context.key))throw new ApiError(502,'IMPORT_REPAIR_RESPONSE_INVALID','修正回复包含无效内容');
  let envelope;try{envelope=JSON.parse(raw);}catch{throw new ApiError(502,'IMPORT_REPAIR_RESPONSE_INVALID','模型回复不是有效JSON');}
  const usage=envelope.usage;
  if(!usage||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(usage[k])&&usage[k]>=0)||usage.total_tokens!==usage.prompt_tokens+usage.completion_tokens)
    throw new ApiError(502,'IMPORT_REPAIR_USAGE_MISSING','模型未返回完整真实用量');
  const observed={usage:{inputTokens:usage.prompt_tokens,outputTokens:usage.completion_tokens,totalTokens:usage.total_tokens},
    providerRequestId:typeof envelope.id==='string'&&/^[A-Za-z0-9_.:/-]{1,200}$/.test(envelope.id)?envelope.id:null};
  // Return observed usage even when result validation fails: caller persists it before validating result.
  if(!Array.isArray(envelope.choices)||envelope.choices.length!==1||envelope.choices[0]?.finish_reason!=='stop'||
    typeof envelope.choices[0]?.message?.content!=='string'||envelope.choices[0].message.tool_calls?.length)
    return {...observed,result:null};
  let result;try{result=JSON.parse(envelope.choices[0].message.content);}catch{result=null;}
  return {...observed,result};
}
