import {ApiError} from './security.js';

// Reviewed 2026-11-04. Exact execution/model IDs only; never price a display-name match.
// Coze: https://docs.coze.cn/coze_pro_internal_integrations_fee
// DeepSeek: https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
const VERSION='assistant-token-cny-2026-11-04';
const COZE_SOURCE='https://docs.coze.cn/coze_pro_internal_integrations_fee';
const DEEPSEEK_SOURCE='https://api-docs.deepseek.com/zh-cn/quick_start/pricing/';
export const ASSISTANT_NANOS_PER_POINT=1_000_000_000n;
export const ASSISTANT_NANOS_PER_CENTIPOINT=10_000_000n;
export const ASSISTANT_POINTS_PER_YUAN=20;
export const ASSISTANT_PRICE_MULTIPLIER='1.4';
const fail=(code,message)=>{throw new ApiError(422,code,message);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const tier=(maxInput,input,output,cached,maxOutput=null)=>({maxInput,maxOutput,input,output,cached});
const doubao=(input,output,cached)=>[
  tier(32000,input[0],output[0],cached[0]),tier(128000,input[1],output[1],cached[1]),
  tier(256000,input[2],output[2],cached[2])];
const COZE=Object.freeze({
  'doubao-seed-2-0-pro-260215':{provider:'doubao',maxInput:256000,tiers:doubao(['3.2','4.8','9.6'],['16','24','48'],['0.64','0.96','1.92'])},
  'doubao-seed-2-0-lite-260215':{provider:'doubao',maxInput:256000,tiers:doubao(['0.6','0.9','1.8'],['3.6','5.4','10.8'],['0.12','0.18','0.36'])},
  'doubao-seed-2-0-mini-260215':{provider:'doubao',maxInput:256000,tiers:doubao(['0.2','0.4','0.8'],['2','4','8'],['0.04','0.08','0.16'])},
  'glm-4-7-251222':{provider:'glm',maxInput:200000,tiers:[tier(32000,'2','8','0.4',200),tier(32000,'3','14','0.6'),tier(200000,'4','16','0.8')]}
});

// State Council 2026 holiday notice; weekends are always off-peak, including make-up workdays.
// https://www.gov.cn/zhengce/content/202511/content_7047090.htm
const HOLIDAYS_2026=[['01-01','01-03'],['02-15','02-23'],['04-04','04-06'],['05-01','05-05'],
  ['06-19','06-21'],['09-25','09-27'],['10-01','10-07']];
export function deepseekPricePeriod(timestamp){
  if(!Number.isSafeInteger(timestamp)||timestamp<0)fail('ASSISTANT_PRICE_UNAVAILABLE','计费时间无效，未调用模型');
  const date=new Date(timestamp+8*60*60*1000),year=date.getUTCFullYear();
  if(year!==2026)fail('ASSISTANT_PRICE_UNAVAILABLE','DeepSeek法定节假日价格日历尚未更新，未猜测单价');
  const day=date.getUTCDay(),md=String(date.getUTCMonth()+1).padStart(2,'0')+'-'+String(date.getUTCDate()).padStart(2,'0');
  const holiday=HOLIDAYS_2026.some(([start,end])=>md>=start&&md<=end);
  const minutes=date.getUTCHours()*60+date.getUTCMinutes();
  return day>=1&&day<=5&&!holiday&&(minutes>=540&&minutes<720||minutes>=840&&minutes<1080)?'peak':'off_peak';
}

export function assistantTokenPricing(config,timestamp=Date.now()){
  if(!record(config))return null;
  const execution=config.execution??'official',modelId=config.modelId;
  if(execution==='coze'){
    const value=COZE[modelId];
    if(!value||value.provider!==config.provider)return null;
    return {version:VERSION,source:COZE_SOURCE,execution,modelId,provider:config.provider,currency:'CNY',
      pointsPerYuan:20,multiplier:'1.4',maxInput:value.maxInput,period:'standard',tiers:value.tiers};
  }
  if(execution!=='official'||config.provider!=='deepseek'||config.baseUrl!=='https://api.deepseek.com'||
    !['deepseek-flash','deepseek-v4-pro'].includes(modelId))return null;
  const period=deepseekPricePeriod(timestamp),peak=period==='peak',flash=modelId==='deepseek-flash';
  const prices=flash?(peak?['2','8','0.04']:['1','4','0.02']):(peak?['9','27','0.3']:['4.5','13.5','0.15']);
  return {version:VERSION,source:DEEPSEEK_SOURCE,execution,modelId,provider:'deepseek',currency:'CNY',
    pointsPerYuan:20,multiplier:'1.4',maxInput:1048576,period,tiers:[tier(1048576,...prices)]};
}

/** Provider counters only. Missing cache counters cannot silently become cache misses. */
export function assistantTokenUsage(value){
  if(!record(value)||!['prompt_tokens','completion_tokens','total_tokens'].every(key=>Number.isSafeInteger(value[key])&&value[key]>=0)||
    value.prompt_tokens<1||value.total_tokens!==value.prompt_tokens+value.completion_tokens)
    fail('ASSISTANT_USAGE_UNCONFIRMED','供应商没有返回完整的真实token用量，未按字数估算扣费');
  const candidates=[value.prompt_cache_hit_tokens,value.prompt_tokens_details?.cached_tokens].filter(item=>item!==undefined&&item!==null);
  if(!candidates.length||candidates.some(item=>!Number.isSafeInteger(item)||item<0||item>value.prompt_tokens)||
    candidates.some(item=>item!==candidates[0]))fail('ASSISTANT_USAGE_UNCONFIRMED','供应商未确认缓存命中token用量，未按未命中价格猜算扣费');
  const hit=candidates[0],miss=value.prompt_tokens-hit;
  if(value.prompt_cache_miss_tokens!==undefined&&value.prompt_cache_miss_tokens!==miss)
    fail('ASSISTANT_USAGE_UNCONFIRMED','供应商输入与缓存用量不一致，未估算扣费');
  return {prompt_tokens:value.prompt_tokens,completion_tokens:value.completion_tokens,total_tokens:value.total_tokens,
    prompt_cache_hit_tokens:hit,prompt_cache_miss_tokens:miss};
}

// A CNY/million-token rate with three decimal places becomes integer nano-points/token at 28 points/CNY.
function nanoRate(rate){
  if(typeof rate!=='string'||!/^\d+(?:\.\d{1,3})?$/u.test(rate))throw new Error('ASSISTANT_PRICE_RECORD_INVALID');
  const [whole,fraction='']=rate.split('.');return (BigInt(whole)*1000n+BigInt(fraction.padEnd(3,'0')))*28n;
}
export function assistantTokenCost(price,usage){
  const rates=price.tiers.find(item=>usage.prompt_tokens<=item.maxInput&&(item.maxOutput===null||usage.completion_tokens<=item.maxOutput));
  if(!rates)fail('ASSISTANT_PRICE_RANGE_UNAVAILABLE','本轮用量超出已核验的价格档位，未猜测计费');
  const nanos=BigInt(usage.prompt_cache_miss_tokens)*nanoRate(rates.input)+
    BigInt(usage.prompt_cache_hit_tokens)*nanoRate(rates.cached)+BigInt(usage.completion_tokens)*nanoRate(rates.output);
  return {nanos,rates};
}

/** A reservation is a conservative budget, never an actual token count or a deduction. */
export function assistantTokenReservation(price,body){
  const serialized=JSON.stringify({messages:body.messages,tools:body.tools});
  const hasImage=(body.messages??[]).some(message=>Array.isArray(message.content)&&message.content.some(part=>part?.type==='image_url'));
  const inputBound=hasImage?price.maxInput:Math.min(price.maxInput,Buffer.byteLength(serialized,'utf8')+
    128*((body.messages?.length??0)+(body.tools?.length??0)+1));
  let output=body.max_tokens??body.max_completion_tokens;
  let source='override';
  if(output===undefined||output===null){
    source='provider_default';
    if(price.execution==='official')output=body.thinking?.type==='disabled'||body.reasoning_effort==='none'?8192:
      body.reasoning_effort==='max'?131072:65536;
    else {output=price.maxInput;source='provider_default_context_ceiling';}
  }
  if(!Number.isSafeInteger(output)||output<1)fail('ASSISTANT_BUDGET_UNCONFIRMED','无法确认当前输出预算，未调用模型');
  const amount=assistantTokenCost(price,{prompt_tokens:inputBound,completion_tokens:output,
    prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:inputBound}).nanos;
  // The account's exact prior remainder is added atomically when the reservation begins.
  return {units:Number((amount+ASSISTANT_NANOS_PER_CENTIPOINT-1n)/ASSISTANT_NANOS_PER_CENTIPOINT),amountNanos:String(amount),
    inputTokenBound:inputBound,outputTokenBudget:output,budgetSource:source};
}
