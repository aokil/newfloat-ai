import {ApiError} from './security.js';

// This exact-ID registry mirrors AssistantThinkingProfiles. Product names and price keys
// deliberately never choose a protocol. Unknown bindings retain provider defaults only.
const defaults=['provider_default'],toggle=['provider_default','enabled','disabled'],fixed=['provider_default','enabled'];
const variableEfforts=['provider_default','low','high'];
const deepseekEfforts=['provider_default','low','high','max'];
const requestEfforts=['provider_default','low','high','max'];
const has=(model,values)=>values.includes(model);
const fail=message=>{throw new ApiError(422,'THINKING_CONFIGURATION_UNSUPPORTED',message);};
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

function outputLimit(provider,model){
  if(provider==='deepseek'&&has(model,['deepseek-flash','deepseek-v4-pro']))return 393216;
  if(provider==='qwen'&&has(model,['qwen3.5-plus','qwen3.5-plus-2026-02-15','qwen3.5-plus-2026-04-20','qwen3.5-flash','qwen3.5-flash-2026-02-23']))return 65536;
  if(provider==='glm'&&has(model,['glm-5','glm-4.7']))return 131072;
  if(provider==='minimax'&&has(model,['MiniMax-M3','MiniMax-M3.1-Flash']))return 524288;
  if(provider==='minimax'&&has(model,['MiniMax-M2','MiniMax-M2.1','MiniMax-M2.1-highspeed','MiniMax-M2.5','MiniMax-M2.5-highspeed','MiniMax-M2.7','MiniMax-M2.7-highspeed']))return 204800;
  return null;
}

export function assistantThinkingProfile(config={}){
  const provider=config.provider??'',modelId=config.modelId??'';
  const profile=(style,{modes=toggle,efforts=defaults,defaultMode='enabled',defaultEffort='provider_default',fixed:isFixed=false,reason=''}={})=>
    ({version:1,id:`${provider}:${modelId}:v1`,provider,modelId,modes:[...modes],efforts:[...efforts],fixed:isFixed,reason,defaultMode,defaultEffort,style,maxOutputTokensLimit:outputLimit(provider,modelId)});
  if(config.execution==='coze'){
    // Explicit Coze gateway IDs, not display names or billing/catalog aliases.
    const toggles={doubao:['doubao-seed-2-0-pro-260215','doubao-seed-2-0-lite-260215','doubao-seed-2-0-mini-260215'],
      glm:['glm-5-0-260211','glm-5-turbo-260316','glm-4-7-251222'],qwen:['qwen-3-5-plus-260215']};
    const isFixed=provider==='minimax'&&has(modelId,['minimax-m2-5-260212','minimax-m2-7-260318']);
    return {version:1,id:`coze:${provider}:${modelId}:json-v1`,provider,modelId,
      modes:[...(isFixed?fixed:has(modelId,toggles[provider]??[])?toggle:defaults)],efforts:[...defaults],fixed:isFixed,
      reason:isFixed?'该实际型号固定思考；采用Coze JSON操作规划，不冒充原生工具调用':
        '采用Coze JSON操作规划；按明确型号及公开SDK参数配置thinking，网关是否接受以真实响应为准；其余仅接口默认，暂不发送档位参数',
      defaultMode:isFixed?'enabled':'provider_default',defaultEffort:'provider_default',
      style:isFixed?'coze_json_fixed':'coze_json',maxOutputTokensLimit:null};
  }
  if(provider==='deepseek'&&has(modelId,['deepseek-flash','deepseek-v4-pro']))return profile('deepseek',{efforts:deepseekEfforts,defaultEffort:'high'});
  if(provider==='qwen'&&has(modelId,['qwen3.5-plus','qwen3.5-plus-2026-02-15','qwen3.5-plus-2026-04-20','qwen3.5-flash','qwen3.5-flash-2026-02-23']))return profile('qwen');
  if(provider==='qwen'&&has(modelId,['qwen-plus','qwen-plus-latest','qwen-plus-2025-04-28','qwen-flash','qwen-flash-2025-07-28']))return profile('qwen',{defaultMode:'disabled'});
  if(provider==='glm'&&has(modelId,['glm-5.3','glm-5.3-flash']))return profile('glm',{modes:fixed,efforts:variableEfforts,defaultEffort:'max',fixed:true,reason:'该型号固定开启思考，不能关闭'});
  if(provider==='glm'&&modelId==='glm-5.2')return profile('glm',{efforts:['provider_default','high'],defaultEffort:'max'});
  if(provider==='glm'&&has(modelId,['glm-5','glm-5-turbo','glm-5.1','glm-4.7','glm-4.6','glm-4.5']))return profile('glm');
  if(provider==='minimax'&&has(modelId,['MiniMax-M2','MiniMax-M2.1','MiniMax-M2.1-highspeed','MiniMax-M2.5','MiniMax-M2.5-highspeed','MiniMax-M2.7','MiniMax-M2.7-highspeed']))return profile('minimax_fixed',{modes:fixed,fixed:true,reason:'该型号固定思考；reasoning_split仅分离输出字段，不能关闭思考'});
  if(provider==='minimax'&&modelId==='MiniMax-M3.1-Flash')return profile('minimax_fixed',{modes:fixed,efforts:variableEfforts,defaultEffort:'max',fixed:true,reason:'该型号固定思考，不能关闭'});
  if(provider==='minimax'&&modelId==='MiniMax-M3')return profile('minimax_adaptive');
  if(provider==='doubao'&&has(modelId,['doubao-seed-evolving','doubao-seed-2-1-pro-260915','doubao-seed-2-1-lite-260915','doubao-seed-2-1-pro-260628','doubao-seed-2-1-turbo-260628']))return profile('doubao',{efforts:variableEfforts,defaultEffort:'high'});
  if(provider==='doubao'&&has(modelId,['doubao-seed-2-0-lite-260428','doubao-seed-2-0-mini-260428']))return profile('doubao',{efforts:variableEfforts,defaultEffort:'medium'});
  return {version:1,id:'unknown:v1',provider:provider||'openai_compatible',modelId,modes:[...defaults],efforts:[...defaults],fixed:false,
    reason:'尚无该实际型号的可信思考参数资料，仅沿用接口默认；未强加供应商扩展参数',defaultMode:'provider_default',defaultEffort:'provider_default',style:'unknown',maxOutputTokensLimit:null};
}

/** Only whitelisted user preferences are accepted; no raw provider parameter object. */
export function assistantThinkingRequest(body){
  if(body.thinking===undefined&&body.maxOutputTokens===undefined&&body.expectedModelId===undefined)return {};
  const choice=body.thinking??{};
  if(!record(choice)||Object.keys(choice).some(key=>!['mode','effort'].includes(key)))throw new ApiError(400,'ASSISTANT_THINKING_INVALID','思考配置格式无效');
  const mode=choice.mode??'provider_default',effort=choice.effort??'provider_default',maxOutputTokens=body.maxOutputTokens??0;
  if(!toggle.includes(mode)||!requestEfforts.includes(effort))throw new ApiError(400,'ASSISTANT_THINKING_INVALID','思考模式或档位无效');
  if(!Number.isSafeInteger(maxOutputTokens)||maxOutputTokens<0||maxOutputTokens>524288)throw new ApiError(400,'ASSISTANT_OUTPUT_BUDGET_INVALID','输出预算须为官方默认（0）或1至524288整数，同时受实际型号限制');
  const expectedModelId=body.expectedModelId;
  if(expectedModelId!==undefined&&(typeof expectedModelId!=='string'||!expectedModelId||expectedModelId.length>200||/[\r\n\0]/u.test(expectedModelId)))throw new ApiError(400,'ASSISTANT_THINKING_INVALID','实际模型校验信息无效');
  return {thinking:{mode,effort},maxOutputTokens,...(expectedModelId!==undefined?{expectedModelId}:{})};
}

/** Configure actual HTTP parameters, and return only a safe effective request snapshot. */
export function applyAssistantThinking(config,request,body){
  if(request.thinking===undefined)return null;
  if(request.expectedModelId!==undefined&&request.expectedModelId!==config.modelId)throw new ApiError(409,'MODEL_CONFIGURATION_CHANGED','内置模型实际型号已变化，请刷新选择并重新开始，未混用旧模型工具历史');
  const profile=assistantThinkingProfile(config),{mode,effort}=request.thinking,budget=request.maxOutputTokens??0;
  if(!profile.modes.includes(mode))fail(`该实际型号不能执行所选思考模式：${mode}。${profile.reason}`);
  if(!profile.efforts.includes(effort))fail(`该实际型号不支持所选思考档位：${effort}。${profile.reason}`);
  if(mode==='disabled'&&effort!=='provider_default')fail('关闭思考时不能同时指定思考档位，请改为默认档位');
  if(profile.style==='deepseek'&&(mode!=='provider_default'||effort==='max'))body.thinking={type:mode==='provider_default'?'enabled':mode};
  if(['glm','doubao'].includes(profile.style)&&mode!=='provider_default')body.thinking={type:mode};
  if(profile.style==='coze_json'&&mode!=='provider_default')body.thinking={type:mode};
  if(profile.style==='coze_json_fixed')body.thinking={type:'enabled'};
  if(profile.style==='qwen'&&mode!=='provider_default')body.enable_thinking=mode==='enabled';
  if(['minimax_fixed','minimax_adaptive'].includes(profile.style)){
    body.reasoning_split=true;
    if(profile.style==='minimax_adaptive'&&mode!=='provider_default')body.thinking={type:mode==='enabled'?'adaptive':'disabled'};
  }
  if(mode==='disabled')delete body.reasoning_effort;
  else if(effort!=='provider_default')body.reasoning_effort=effort;
  if(profile.style==='glm'&&mode!=='disabled'&&has(profile.modelId,['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-4.7'])){
    body.thinking??={type:'enabled'};body.thinking.clear_thinking=false;
  }
  delete body.max_tokens;delete body.max_completion_tokens;
  if(budget>0){
    if(profile.maxOutputTokensLimit!==null&&budget>profile.maxOutputTokensLimit)fail(`所选输出预算超过该实际型号已核对的上限 ${profile.maxOutputTokensLimit} token`);
    body[(config.execution!=='coze'&&['minimax','doubao'].includes(profile.provider)&&profile.style!=='unknown')?'max_completion_tokens':'max_tokens']=budget;
  }
  if(body.tools?.length)body.tool_choice='auto';else delete body.tool_choice;
  const effectiveMode=mode==='provider_default'?profile.defaultMode:mode;
  const effectiveEffort=effectiveMode==='disabled'?'not_applicable':effort==='provider_default'?profile.defaultEffort:effort;
  const parameters=Object.fromEntries(['thinking','enable_thinking','reasoning_effort','reasoning_split','max_tokens','max_completion_tokens'].filter(key=>Object.hasOwn(body,key)).map(key=>[key,body[key]]));
  return {configuration_version:1,profile_id:profile.id,provider:profile.provider,model_id:profile.modelId,requested_mode:mode,effective_mode:effectiveMode,
    requested_effort:effort,effective_effort:effectiveEffort,output_budget:budget||null,budget_source:budget?'override':'provider_default',
    output_limit_verified:profile.maxOutputTokensLimit!==null,timeout_seconds:request.timeoutSeconds,parameters,capability_reason:profile.reason};
}
