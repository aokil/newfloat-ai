import {createHash} from 'node:crypto';
import {ApiError} from './security.js';

export const MEDIA_BODY_LIMIT=16*1024*1024;
export const MEDIA_REFERENCE_BYTES=10*1024*1024;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const invalid=message=>{throw new ApiError(400,'MEDIA_REQUEST_INVALID',message);};
const token=(value,name,max=100)=>{if(typeof value!=='string'||!new RegExp(`^[A-Za-z0-9_-]{1,${max}}$`,'u').test(value))invalid(name+'格式无效');return value;};
const keys=(value,allowed)=>{if(!record(value)||Object.keys(value).some(key=>!allowed.includes(key)))invalid('请求含未实现的参数');};
const ordered=value=>Array.isArray(value)?value.map(ordered):record(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;

export function mediaCreateRequest(input){
  keys(input,['jobId','conversationId','taskId','kind','modelId','parameters','references','timeoutSeconds']);
  const jobId=token(input.jobId,'生成任务编号',80),conversationId=token(input.conversationId,'对话编号',100),taskId=token(input.taskId,'任务编号',100);
  if(!['image','video'].includes(input.kind))invalid('请选择图片或视频生成');
  const modelId=input.modelId??'';
  if(typeof modelId!=='string'||modelId.length>200||modelId&&!/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/u.test(modelId))invalid('生成模型ID格式无效');
  const p=input.parameters;
  keys(p,input.kind==='image'?['prompt','size','count','watermark']:['prompt','reference_mode','resolution','ratio','duration','generate_audio','watermark']);
  if(typeof p.prompt!=='string'||!p.prompt.trim()||p.prompt.length>12000)invalid('请输入不超过12000字符的生成需求');
  if(p.size!==undefined&&(typeof p.size!=='string'||p.size.length>32))invalid('图片尺寸格式无效');
  if(p.count!==undefined&&(!Number.isSafeInteger(p.count)||p.count<1||p.count>15))invalid('本次生成张数需为1–15');
  if(p.resolution!==undefined&&!['480p','720p','1080p'].includes(p.resolution))invalid('当前视频接口仅声明480p、720p、1080p');
  if(p.ratio!==undefined&&!['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'].includes(p.ratio))invalid('视频比例不在当前接口支持范围');
  if(p.duration!==undefined&&(!Number.isSafeInteger(p.duration)||p.duration<1))invalid('视频时长需为正整数，并受实际型号单段上限约束');
  if(p.generate_audio!==undefined&&typeof p.generate_audio!=='boolean')invalid('视频声音参数格式无效');
  if(p.watermark!==undefined&&typeof p.watermark!=='boolean')invalid('水印参数格式无效');
  if(p.reference_mode!==undefined&&!['first_frame','first_last_frame','reference_images'].includes(p.reference_mode))invalid('参考图模式无效');
  const references=input.references??[];
  if(!Array.isArray(references)||references.length>14||input.kind==='video'&&references.length>9)invalid('参考图数量超出当前生成接口范围');
  let total=0;
  const normalized=references.map(ref=>{
    keys(ref,['file_id','mimeType','data','sha256']);
    const file_id=token(ref.file_id,'参考图文件编号',80);
    if(!['image/jpeg','image/png','image/webp'].includes(ref.mimeType)||typeof ref.data!=='string'||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(ref.data)||ref.data.length>Math.ceil(MEDIA_REFERENCE_BYTES/3)*4)invalid('参考图格式或大小无效');
    const bytes=Buffer.from(ref.data,'base64');total+=bytes.length;
    if(!bytes.length||bytes.toString('base64')!==ref.data||total>MEDIA_REFERENCE_BYTES)invalid('本次参考图原件合计超过10MiB接口处理范围；未压缩或截断');
    const valid=ref.mimeType==='image/png'?bytes.length>=33&&bytes.subarray(0,8).toString('hex')==='89504e470d0a1a0a':
      ref.mimeType==='image/jpeg'?bytes.length>=4&&bytes.readUInt16BE(0)===0xffd8&&bytes.readUInt16BE(bytes.length-2)===0xffd9:
      bytes.length>=12&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
    if(!valid)invalid('参考图真实格式与声明不一致');
    const sha256=createHash('sha256').update(bytes).digest('hex');
    if(ref.sha256!==undefined&&ref.sha256!==sha256)invalid('参考图原件摘要校验不一致');
    return {file_id,mimeType:ref.mimeType,data:ref.data,sha256};
  });
  const timeoutSeconds=input.timeoutSeconds??45;
  if(!Number.isSafeInteger(timeoutSeconds)||timeoutSeconds<5||timeoutSeconds>120)invalid('单次生成网络请求超时需为5–120秒');
  const semantic={jobId,conversationId,taskId,kind:input.kind,modelId,parameters:p,
    references:normalized.map(({file_id,mimeType,sha256})=>({file_id,mimeType,sha256}))};
  return {...semantic,references:normalized,timeoutSeconds,
    digest:createHash('sha256').update(JSON.stringify(ordered(semantic))).digest('hex')};
}

export function mediaJobId(value){return token(value,'生成任务编号',80);}
export function mediaPublicJob(job){
  return {jobId:job.jobId,conversationId:job.conversationId,taskId:job.taskId,kind:job.kind,modelId:job.modelId,
    status:job.status,providerSubmitted:job.providerSubmitted===true,cancelRequested:job.cancelRequested===true,
    errorCode:job.errorCode??null,message:job.message??'',createdAt:job.createdAt,updatedAt:job.updatedAt,
    requestedCount:job.requestedCount??null,errors:job.partialErrors??[],files:(job.outputs??[]).map((output,index)=>({index,mimeType:output.mimeType,name:output.name})),
    generated:job.status==='succeeded',downloaded:false};
}
