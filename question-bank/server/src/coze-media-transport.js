import {createHash,createHmac,randomBytes} from 'node:crypto';
import {ApiError} from './security.js';
import {MEDIA_BODY_LIMIT} from './assistant-media-contract.js';

const PATH='/internal/media-generation',PROJECT_ID='7689833705046130729';
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// Financial evidence crosses the bridge only as these numeric/enum fields, never raw provider errors.
const mediaEvidence=(value,kind)=>{
  if(!record(value))return {};
  const evidence={},source=value.usage,usage={};
  const keys=kind==='image'?['generated_images','output_tokens','total_tokens']:['completion_tokens','total_tokens'];
  let invalid=false;
  if(record(source))for(const key of keys){
    const count=source[key];if(count===undefined)continue;
    if(typeof count!=='number'||!Number.isSafeInteger(count)||count<0){invalid=true;break;}
    usage[key]=count;
  }
  if(!invalid&&Object.keys(usage).length)evidence.usage=usage;
  const raw=value.providerMetadata,metadata={};
  if(record(raw)){
    if(typeof raw.id==='string'&&/^[A-Za-z0-9_-]{1,200}$/u.test(raw.id))metadata.id=raw.id;
    if(typeof raw.status==='string'&&['queued','running','succeeded','failed','cancelled','expired'].includes(raw.status))metadata.status=raw.status;
    if(typeof raw.model==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/u.test(raw.model))metadata.model=raw.model;
    if(typeof raw.generate_audio==='boolean')metadata.generate_audio=raw.generate_audio;
    if(typeof raw.resolution==='string'&&['480p','720p','1080p'].includes(raw.resolution))metadata.resolution=raw.resolution;
    if(typeof raw.ratio==='string'&&['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'].includes(raw.ratio))metadata.ratio=raw.ratio;
    if(typeof raw.duration==='number'&&Number.isFinite(raw.duration)&&raw.duration>0)metadata.duration=raw.duration;
  }
  if(Object.keys(metadata).length)evidence.providerMetadata=metadata;
  return evidence;
};
const safeMessage=(value,key)=>typeof value==='string'&&value.length<=600&&!value.includes(key)?value
  .replace(/[\r\n\t]/gu,' ').replace(/data:[^\s"'<>]+/giu,'[图片数据]').replace(/https?:\/\/[^\s"'<>]+/giu,'[文件地址]')
  .replace(/\bBearer\s+\S+/giu,'Bearer [隐藏]').replace(/(api[_-]?key|password|secret|token|验证码|密码)\s*[:=]\s*[^\s,;]+/giu,'$1=[隐藏]'):
  'Coze生成桥接未能完成本次请求';

/** Fixed same-project RPC; no provider key, configurable endpoint or generation retry is exposed to App. */
export function remoteCozeMedia(config){
  return async(operation,input,signal)=>{
    if(!config)throw new ApiError(503,'COZE_MEDIA_NOT_READY','Coze生成桥接尚未配置');
    const raw=JSON.stringify({operation,input});
    if(Buffer.byteLength(raw)>MEDIA_BODY_LIMIT)throw new ApiError(413,'MEDIA_REQUEST_TOO_LARGE','完整参考图超过生成请求传输范围，未压缩或截断');
    const timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex'),hash=createHash('sha256').update(raw).digest('hex');
    const signature=createHmac('sha256',config.key).update(`POST\n${PATH}\n${timestamp}\n${nonce}\n${hash}`).digest('hex');
    const combined=AbortSignal.any([signal,AbortSignal.timeout((input.timeoutSeconds??45)*1000)]);
    let response;
    try{response=await fetch(config.origin+PATH,{method:'POST',redirect:'error',signal:combined,body:raw,
      headers:{'content-type':'application/json',accept:'application/json','x-float-llm-timestamp':timestamp,'x-float-llm-nonce':nonce,'x-float-llm-signature':signature}});}
    catch{throw new ApiError(502,'MEDIA_SUBMISSION_UNKNOWN','Coze生成响应未确认，未自动重试付费生成请求');}
    if(!response.body)throw new ApiError(502,'MEDIA_RESULT_INVALID','Coze生成桥接返回空响应');
    const reader=response.body.getReader(),parts=[];let bytes=0;
    try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.length;
      if(bytes>256*1024)throw new ApiError(502,'MEDIA_RESULT_TOO_LARGE','Coze生成元数据超出处理范围');parts.push(part.value);}}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw new ApiError(502,'MEDIA_RESULT_INVALID','Coze生成桥接响应不是有效JSON');}
    if(!record(value))throw new ApiError(502,'MEDIA_RESULT_INVALID','Coze生成桥接响应结构无效');
    if(!response.ok){
      const error=record(value.error)?value.error:{};
      const code=typeof error.code==='string'&&/^[A-Z0-9_]{1,100}$/u.test(error.code)?error.code:'COZE_MEDIA_NOT_READY';
      const message=safeMessage(error.message,config.key);
      const evidence=value.projectId===PROJECT_ID&&value.environment===config.environment&&record(error.details)?
        mediaEvidence(error.details.mediaEvidence,operation==='generate_image'?'image':'video'):{};
      throw new ApiError(response.status,code,message,Object.keys(evidence).length?{mediaEvidence:evidence}:undefined);
    }
    if(value.projectId!==PROJECT_ID||value.environment!==config.environment||!record(value.result))
      throw new ApiError(502,'COZE_MEDIA_IDENTITY_INVALID','Coze生成项目或环境不一致');
    const evidence=mediaEvidence(value.result,operation==='generate_image'?'image':'video');
    if(combined.aborted)throw new ApiError(502,'MEDIA_SUBMISSION_UNKNOWN','Coze生成请求已超时，未交付迟到结果',
      Object.keys(evidence).length?{mediaEvidence:evidence}:undefined);
    const result={...value.result};delete result.usage;delete result.providerMetadata;
    return {...result,...evidence};
  };
}
