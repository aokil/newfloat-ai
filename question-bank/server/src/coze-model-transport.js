import {createHash,createHmac,randomBytes} from 'node:crypto';

const PROJECT_ID='7689833705046130729';
const BRIDGE_PATH='/internal/model-completion';
const RESPONSE_LIMIT=128*1024;
const UUID_DEV_HOST=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.dev\.coze\.site$/u;
const ERROR_CODES=new Set(['PROVIDER_AUTH_FAILED','MODEL_FORBIDDEN','PROVIDER_BALANCE_LOW','PROVIDER_RATE_LIMITED',
  'TIMEOUT_UNKNOWN','NETWORK_UNKNOWN','EMPTY_RESPONSE','TRUNCATED_RESPONSE','INCOMPLETE_RESPONSE','USAGE_MISSING',
  'INVALID_ANSWER','INVALID_PROVIDER_RESPONSE','PROVIDER_RESPONSE_TOO_LARGE','INVALID_TEST_RESULT',
  'COZE_INTEGRATION_NOT_READY','COZE_MODEL_LIST_UNAVAILABLE','COZE_MODEL_UNAVAILABLE','PROJECT_IDENTITY_UNAVAILABLE','PROVIDER_FAILED']);
const BRIDGE_ERRORS=Object.freeze({NOT_FOUND:'COZE_INTEGRATION_NOT_READY',
  PROJECT_IDENTITY_UNAVAILABLE:'PROJECT_IDENTITY_UNAVAILABLE',MODEL_AUTH_UNAVAILABLE:'COZE_INTEGRATION_NOT_READY',
  MODEL_LIST_UNAVAILABLE:'COZE_MODEL_LIST_UNAVAILABLE',INVALID_MODEL_REQUEST:'INVALID_PROVIDER_RESPONSE',
  MODEL_NOT_AVAILABLE:'COZE_MODEL_UNAVAILABLE',MODEL_RATE_LIMITED:'PROVIDER_RATE_LIMITED',MODEL_TIMEOUT:'TIMEOUT_UNKNOWN',
  MODEL_IMAGE_UNSUPPORTED:'MODEL_IMAGE_UNSUPPORTED',
  REQUEST_CANCELLED:'NETWORK_UNKNOWN',MODEL_OUTPUT_LIMIT_EXCEEDED:'TRUNCATED_RESPONSE',MODEL_RESPONSE_INVALID:'INVALID_PROVIDER_RESPONSE',
  MODEL_USAGE_UNAVAILABLE:'USAGE_MISSING',MODEL_RESPONSE_INCOMPLETE:'INCOMPLETE_RESPONSE',MODEL_REQUEST_REJECTED:'PROVIDER_FAILED',
  MODEL_UPSTREAM_UNAVAILABLE:'NETWORK_UNKNOWN'});
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const validKey=value=>typeof value==='string'&&value.length>=32&&value.length<=512&&/^[\x21-\x7e]+$/u.test(value);

function configuration(env){
  try{
    const raw=env.COZE_LLM_ORIGIN||'';
    if(raw.length>2048||/[\u0000-\u0020\u007f]/u.test(raw))return null;
    const origin=new URL(raw),environment=env.COZE_LLM_ENVIRONMENT||'PROD';
    // Reject paths/ports that URL normalization could otherwise turn into a root origin.
    if(raw!==origin.origin&&raw!==origin.origin+'/')return null;
    if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash)return null;
    if(environment==='PROD'?origin.hostname!=='d635c6m6jj.coze.site':environment!=='DEV'||!UUID_DEV_HOST.test(origin.hostname))return null;
    let key=env.TIYU_LLM_BRIDGE_KEY;
    if(key===undefined&&validKey(env.TIYU_GATEWAY_KEY))key=createHmac('sha256',env.TIYU_GATEWAY_KEY).update('float-ai/coze-llm-bridge/v1').digest('hex');
    if(!validKey(key))return null;
    return {origin:origin.origin,environment,key};
  }catch{return null;}
}

function usage(value){
  if(!record(value)||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(value[k])&&value[k]>=0)||
    value.prompt_tokens<=0||value.completion_tokens<=0||value.total_tokens!==value.prompt_tokens+value.completion_tokens)throw new Error('USAGE_MISSING');
  return {prompt_tokens:value.prompt_tokens,completion_tokens:value.completion_tokens,total_tokens:value.total_tokens};
}
function receipt(value,mode){
  if(!record(value))throw new Error('INVALID_PROVIDER_RESPONSE');
  const result={usage:usage(value.usage),latencyMs:Number.isFinite(value.latencyMs)&&value.latencyMs>=0?value.latencyMs:null,
    providerRequestId:typeof value.providerRequestId==='string'&&value.providerRequestId.length<=200?value.providerRequestId:null};
  if(mode==='test'){
    if(value.status!=='passed')throw new Error('INVALID_TEST_RESULT');
    return {status:'passed',...result};
  }
  if(typeof value.answer!=='string'||!value.answer.trim()||value.answer.length>16000||typeof value.explanation!=='string'||value.explanation.length>16000)throw new Error('INVALID_ANSWER');
  return {answer:value.answer,explanation:value.explanation,...result};
}
function modelMetadata(value){
  if(!Array.isArray(value)||!value.length||value.length>2000)throw new Error('COZE_MODEL_LIST_UNAVAILABLE');
  return value.map(item=>{
    if(!record(item)||typeof item.model_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(item.model_id))throw new Error('COZE_MODEL_LIST_UNAVAILABLE');
    const result={model_id:item.model_id};
    for(const field of ['model_name','show_name','model_desc','model_version']){
      if(item[field]===undefined)continue;
      if(typeof item[field]!=='string'||item[field].length>2000)throw new Error('COZE_MODEL_LIST_UNAVAILABLE');
      result[field]=item[field];
    }
    for(const field of ['input_types','output_types']){
      if(item[field]===undefined)continue;
      if(!Array.isArray(item[field])||item[field].length>32||item[field].some(type=>typeof type!=='string'||type.length>64))throw new Error('COZE_MODEL_LIST_UNAVAILABLE');
      result[field]=[...item[field]];
    }
    return result;
  });
}

/** Only the account server may call this fixed Coze execution bridge. No retries. */
export function configuredCozeBridge(env=process.env){
  const config=configuration(env);
  async function invoke(method,body,budgetMs,requestId){
    if(!config)throw new Error('COZE_INTEGRATION_NOT_READY');
    const rawBody=body===undefined?'':JSON.stringify(body),timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');
    const digest=createHash('sha256').update(rawBody).digest('hex');
    const signature=createHmac('sha256',config.key).update(`${method}\n${BRIDGE_PATH}\n${timestamp}\n${nonce}\n${digest}`).digest('hex');
    const signal=AbortSignal.timeout(budgetMs);let response;
    try{
      response=await fetch(config.origin+BRIDGE_PATH,{method,redirect:'error',signal,headers:{accept:'application/json',
        ...(method==='POST'?{'content-type':'application/json'}:{}),'x-float-llm-timestamp':timestamp,'x-float-llm-nonce':nonce,'x-float-llm-signature':signature},
        ...(body===undefined?{}:{body:rawBody})});
    }catch{throw new Error(signal.aborted?'TIMEOUT_UNKNOWN':'NETWORK_UNKNOWN');}
    if(!response.body)throw new Error('EMPTY_RESPONSE');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
        if(size>RESPONSE_LIMIT){await reader.cancel();throw new Error('PROVIDER_RESPONSE_TOO_LARGE');}chunks.push(value);}
    }catch(error){if(error?.message==='PROVIDER_RESPONSE_TOO_LARGE')throw error;throw new Error(signal.aborted?'TIMEOUT_UNKNOWN':'NETWORK_UNKNOWN');}
    finally{reader.releaseLock();}
    const raw=Buffer.concat(chunks).toString('utf8');
    if(raw.includes(config.key))throw new Error('INVALID_PROVIDER_RESPONSE');
    let payload;try{payload=JSON.parse(raw);}catch{throw new Error('INVALID_PROVIDER_RESPONSE');}
    if(!response.ok){
      const code=record(payload)&&record(payload.error)?payload.error.code:null;
      const safe=typeof code==='string'&&Object.hasOwn(BRIDGE_ERRORS,code)?BRIDGE_ERRORS[code]:ERROR_CODES.has(code)?code:null;
      throw new Error(safe|| (response.status===401?'PROVIDER_AUTH_FAILED':response.status===403?'MODEL_FORBIDDEN':response.status===429?'PROVIDER_RATE_LIMITED':'COZE_INTEGRATION_NOT_READY'));
    }
    if(!record(payload)||payload.projectId!==PROJECT_ID||payload.environment!==config.environment||(requestId!==undefined&&payload.requestId!==requestId))throw new Error('INVALID_PROVIDER_RESPONSE');
    return payload;
  }
  async function execute(mode,model,question,context){
    const requestId=context?.requestId;
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/u.test(requestId)||typeof model.modelId!=='string'||!model.modelId.trim()||model.modelId.length>200||/[\r\n\u0000]/u.test(model.modelId)||
      !Number.isSafeInteger(model.timeoutMs)||model.timeoutMs<3000||model.timeoutMs>30000||!Number.isSafeInteger(model.maxOutputTokens)||model.maxOutputTokens<1||model.maxOutputTokens>8192)throw new Error('INVALID_PROVIDER_RESPONSE');
    if(mode==='search'&&(typeof question!=='string'||!question.trim()||question.length>16000))throw new Error('INVALID_ANSWER');
    const payload=await invoke('POST',{requestId,mode,modelId:model.modelId,...(mode==='search'?{question,...(context?.image?{image:context.image}:{})}:{}),
      timeoutMs:Math.min(model.timeoutMs-2000,25000),maxOutputTokens:model.maxOutputTokens},model.timeoutMs,requestId);
    return receipt(payload.result,mode);
  }
  return Object.freeze({ready:!!config,
    async metadata(){
      if(!config)throw new Error('COZE_INTEGRATION_NOT_READY');
      try{const result=await invoke('GET',undefined,22000);return {projectId:PROJECT_ID,environment:config.environment,items:modelMetadata(result.items)};}
      catch{throw new Error('COZE_MODEL_LIST_UNAVAILABLE');}
    },
    test(model,context){return execute('test',model,undefined,context);},
    search(model,question,context){return execute('search',model,question,context);}});
}

export {BRIDGE_ERRORS};
