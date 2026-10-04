import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {ApiError,sha256} from './security.js';
import {catalogEntry} from './model-catalog.js';
import {ANSWER_ONLY_PROMPT,answerBudget,minimalAnswer} from './answer-only.js';
export const MODEL_ORIGINS=Object.freeze({deepseek:'https://api.deepseek.com',doubao:'https://ark.cn-beijing.volces.com/api/v3',
  glm:'https://open.bigmodel.cn/api/paas/v4',minimax:'https://api.minimax.io/v1',qwen:'https://dashscope.aliyuncs.com/compatible-mode/v1'});
export const BYOK_PROVIDERS=Object.freeze(Object.entries(MODEL_ORIGINS).map(([id,baseUrl])=>({id,baseUrl,name:{deepseek:'DeepSeek',doubao:'豆包',glm:'GLM',minimax:'MiniMax',qwen:'Qwen'}[id]})));
const PROVIDER_ERROR_CODES=new Set(['INVALID_PROVIDER','PROVIDER_AUTH_FAILED','MODEL_FORBIDDEN','PROVIDER_BALANCE_LOW','PROVIDER_RATE_LIMITED',
  'TIMEOUT_UNKNOWN','NETWORK_UNKNOWN','EMPTY_RESPONSE','TRUNCATED_RESPONSE','INCOMPLETE_RESPONSE','USAGE_MISSING',
  'INVALID_ANSWER','INVALID_PROVIDER_RESPONSE','PROVIDER_RESPONSE_TOO_LARGE','INVALID_TEST_RESULT',
  'COZE_INTEGRATION_NOT_READY','COZE_MODEL_LIST_UNAVAILABLE','COZE_MODEL_UNAVAILABLE','PROJECT_IDENTITY_UNAVAILABLE']);
export function providerFailureCode(error){
  const code=error?.message;
  return PROVIDER_ERROR_CODES.has(code)||/^PROVIDER_HTTP_\d{3}$/u.test(code||'')?code:'PROVIDER_FAILED';
}
export function modelConfig(input,old={}){
  const execution=input.execution===undefined?(old.execution??'official'):input.execution;
  if(!['official','coze'].includes(execution))throw new ApiError(400,'INVALID_REQUEST','请选择官方接口或 Coze 内置集成');
  if(execution==='coze'&&(Object.hasOwn(input,'apiKey')||Object.hasOwn(input,'removeKey')||(input.baseUrl!==undefined&&input.baseUrl!==null)))throw new ApiError(400,'INVALID_REQUEST','Coze 集成不接收 API Key 或自定义接口地址');
  const value={execution,provider:input.provider??old.provider,displayName:input.displayName??old.displayName,modelId:input.modelId??old.modelId,
    baseUrl:execution==='coze'?null:input.baseUrl??old.baseUrl,enabled:input.enabled??old.enabled??false,capabilities:input.capabilities??old.capabilities??['text'],
    maxOutputTokens:input.maxOutputTokens??old.maxOutputTokens??256,timeoutMs:input.timeoutMs??old.timeoutMs??(execution==='coze'?30000:10000),
    dailyRequestLimit:input.dailyRequestLimit??old.dailyRequestLimit??10,pointsPerCall:input.pointsPerCall??old.pointsPerCall,
    catalogKey:input.catalogKey===undefined?(old.catalogKey??null):input.catalogKey};
  if(value.catalogKey!==null){const item=catalogEntry(value.catalogKey);if(!item||item.provider!==value.provider)throw new ApiError(400,'INVALID_REQUEST','模型目录与服务商不匹配');
    if(input.pointsPerCall!==undefined&&input.pointsPerCall!==item.pointsPerCall)throw new ApiError(400,'INVALID_REQUEST','该模型必须使用固定点数档位');value.pointsPerCall=item.pointsPerCall;}
  if(execution==='coze'&&!value.catalogKey)throw new ApiError(400,'INVALID_REQUEST','Coze 内置模型必须绑定点数目录型号');
  if(!Object.keys(MODEL_ORIGINS).includes(value.provider)||(execution==='official'&&value.baseUrl!==MODEL_ORIGINS[value.provider]))throw new ApiError(400,'INVALID_REQUEST','模型服务必须为已核对的官方HTTPS地址');
  for(const key of ['displayName','modelId'])if(typeof value[key]!=='string'||!value[key].trim()||value[key].length>200||/[\r\n\u0000]/u.test(value[key]))throw new ApiError(400,'INVALID_REQUEST','请填写模型名称与真实模型ID');
  if(typeof value.enabled!=='boolean'||!Array.isArray(value.capabilities)||value.capabilities.length!==1||value.capabilities[0]!=='text')throw new ApiError(400,'INVALID_REQUEST','本轮测试仅验证text能力；不能假报图像能力');
  for(const [key,min,max] of [['maxOutputTokens',1,8192],['timeoutMs',execution==='coze'?3000:1000,30000],['dailyRequestLimit',1,10000],['pointsPerCall',1,1000000]])if(!Number.isSafeInteger(value[key])||value[key]<min||value[key]>max)throw new ApiError(400,'INVALID_REQUEST',`${key}范围无效`);
  return value;
}
function masterKey(value){let key;try{key=Buffer.from(value||'','base64');}catch{}if(key?.length!==32)throw new ApiError(503,'MODEL_KEY_NOT_CONFIGURED','未配置模型密钥加密主密钥');return key;}
export function sealKey(secret,master){if(typeof secret!=='string'||secret.length<8||secret.length>4096||/[\r\n]/u.test(secret))throw new ApiError(400,'INVALID_REQUEST','API Key格式无效');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',masterKey(master),iv);const bytes=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:bytes.toString('base64')});}
export function openKey(value,master){const j=JSON.parse(value),decipher=createDecipheriv('aes-256-gcm',masterKey(master),Buffer.from(j.iv,'base64'));decipher.setAuthTag(Buffer.from(j.tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(j.data,'base64')),decipher.final()]).toString('utf8');}
export function modelView(row){return {id:row.id,execution:'official',...JSON.parse(row.config),revision:row.revision,keyConfigured:!!row.encrypted_key,keyFingerprint:row.key_fingerprint?.slice(0,12)??null,lastTestAt:row.last_test_at?new Date(row.last_test_at).toISOString():null,lastTestStatus:row.last_test_status??'not_tested',lastTestErrorCode:row.last_test_error??null,...(row.last_test_result?{lastTestResult:JSON.parse(row.last_test_result)}:{})};}
export function byokConfiguration(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['provider','modelId','apiKey','baseUrl'].includes(k)))throw new ApiError(400,'INVALID_REQUEST','自带模型配置无效');
  let provider=input.provider,baseUrl=input.baseUrl;
  if(typeof baseUrl==='string')baseUrl=baseUrl.replace(/\/+$/u,'');
  if(provider==='custom'){provider=Object.entries(MODEL_ORIGINS).find(([,url])=>url===baseUrl)?.[0];}
  if(typeof provider!=='string'||!Object.hasOwn(MODEL_ORIGINS,provider)||(baseUrl!==undefined&&baseUrl!==MODEL_ORIGINS[provider]))throw new ApiError(400,'INVALID_MODEL_ORIGIN','仅支持列表中的官方HTTPS接口地址');
  if(typeof input.modelId!=='string'||!input.modelId.trim()||input.modelId.length>200||/[\r\n]/u.test(input.modelId))throw new ApiError(400,'INVALID_REQUEST','请填写供应商实际模型ID');
  if(typeof input.apiKey!=='string'||input.apiKey.trim().length<8||input.apiKey.length>4096||/[\r\n]/u.test(input.apiKey))throw new ApiError(400,'INVALID_REQUEST','API Key格式无效');
  if(input.modelId.includes(input.apiKey.trim()))throw new ApiError(400,'INVALID_REQUEST','模型ID不能包含API Key');
  return {provider,baseUrl:MODEL_ORIGINS[provider],modelId:input.modelId.trim(),timeoutMs:25000,maxOutputTokens:4096,apiKey:input.apiKey.trim()};
}
async function officialCompletion(config,apiKey,messages,maxTokens){
  // Never use administrator-provided arbitrary URLs or follow redirects.
  if(config.baseUrl!==MODEL_ORIGINS[config.provider])throw new Error('INVALID_PROVIDER');
  const start=Date.now();let response;
  const body={model:config.modelId,messages,max_tokens:maxTokens,stream:false};
  if(config.provider==='qwen')body.enable_thinking=false;
  else if(config.provider==='minimax')body.reasoning_split=true;
  else body.thinking={type:'disabled'};
  try{response=await fetch(`${config.baseUrl}/chat/completions`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(config.timeoutMs),headers:{authorization:`Bearer ${apiKey}`,'content-type':'application/json'},body:JSON.stringify(body)});}
  catch(error){throw new Error(error.name==='TimeoutError'?'TIMEOUT_UNKNOWN':'NETWORK_UNKNOWN');}
  if(!response.ok){await response.body?.cancel();throw new Error(response.status===401?'PROVIDER_AUTH_FAILED':response.status===403?'MODEL_FORBIDDEN':response.status===402?'PROVIDER_BALANCE_LOW':response.status===429?'PROVIDER_RATE_LIMITED':`PROVIDER_HTTP_${response.status}`);}
  if(!response.body)throw new Error('EMPTY_RESPONSE');
  const reader=response.body.getReader();let total=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>128*1024){await reader.cancel();throw new Error('PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(value);}}
  catch(error){if(error.message==='PROVIDER_RESPONSE_TOO_LARGE')throw error;throw new Error(error.name==='TimeoutError'?'TIMEOUT_UNKNOWN':'NETWORK_UNKNOWN');}
  let result;try{result=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new Error('INVALID_PROVIDER_RESPONSE');}const choice=result.choices?.[0];
  if(!choice||typeof choice.message?.content!=='string'||!choice.message.content.trim())throw new Error('EMPTY_RESPONSE');
  if(choice.finish_reason==='length')throw new Error('TRUNCATED_RESPONSE');
  if(choice.finish_reason!=='stop')throw new Error('INCOMPLETE_RESPONSE');
  if(!result.usage||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(result.usage[k])&&result.usage[k]>=0))throw new Error('USAGE_MISSING');
  const content=choice.message.content.replace(/<think>[\s\S]*?<\/think>/gu,'').trim();
  if(!content||content.includes('<think>'))throw new Error('EMPTY_RESPONSE');
  // Provider responses are data. Reflected credentials must never enter receipts or errors.
  if(content.includes(apiKey)||(typeof result.id==='string'&&result.id.includes(apiKey)))throw new Error('INVALID_PROVIDER_RESPONSE');
  return {content,latencyMs:Date.now()-start,usage:{prompt_tokens:result.usage.prompt_tokens,completion_tokens:result.usage.completion_tokens,total_tokens:result.usage.total_tokens},providerRequestId:typeof result.id==='string'?result.id.slice(0,200):null};
}
export async function officialModelTest(config,apiKey){
  const {content,...receipt}=await officialCompletion(config,apiKey,[{role:'user',content:'Reply with OK.'}],config.provider==='minimax'?config.maxOutputTokens:Math.min(config.maxOutputTokens,32));
  return {status:'passed',...receipt};
}
export async function officialModelSearch(config,apiKey,question){
  const {content,...receipt}=await officialCompletion(config,apiKey,[
    {role:'system',content:ANSWER_ONLY_PROMPT},
    {role:'user',content:question}
  ],Math.min(config.maxOutputTokens,answerBudget(question)));
  let parsed;try{parsed=JSON.parse(content.replace(/^```(?:json)?\s*/u,'').replace(/\s*```$/u,''));}catch{}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||typeof parsed.answer!=='string')throw new Error('INVALID_ANSWER');
  const answer=minimalAnswer(parsed.answer,question);
  return {answer,explanation:'',...receipt};
}
