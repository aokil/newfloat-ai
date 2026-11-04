import {ImageConfig,VideoConfig,buildImageGenerationApiRequest,validateImageSize} from 'coze-coding-dev-sdk';
import {ApiError} from '../../question-bank/server/src/security.js';
import {mediaCreateRequest} from '../../question-bank/server/src/assistant-media-contract.js';
import {cozeGenerationRuntime,readAuthenticatedMediaBody,denyModelCompletion} from './coze-llm.server';

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const PROJECT_ID='7689833705046130729';
function fail(status:number,code:string,message:string):never {throw new ApiError(status,code,message);}
const modelName=(id:string,kind:string)=>id==='doubao-seedream-5-0-260128'?'Seedream 5.0 Lite':id==='doubao-seedance-2-0-260128'?'Seedance 2.0':`${kind==='image'?'图片':'视频'}生成 · ${id}`;
const IMAGE_45='doubao-seedream-4-5-251128',VIDEO_15='doubao-seedance-1-5-pro-251215';

/** Only concrete SDK/documented model IDs are listed. Reference screenshots grant no capabilities. */
function catalogue(){
  return {items:[
    {id:IMAGE_45,name:'Seedream 4.5',kind:'image',provider:'doubao',default:false,available:true,verified:false,
      defaults:{size:ImageConfig.DEFAULT_SIZE,watermark:ImageConfig.DEFAULT_WATERMARK},referenceImages:true,sizes:['2K','4K'],maxReferenceImages:14,source:'coze_documented_integration'},
    {id:ImageConfig.DEFAULT_MODEL,name:modelName(ImageConfig.DEFAULT_MODEL,'image'),kind:'image',provider:'doubao',default:true,available:true,verified:false,
      defaults:{size:ImageConfig.DEFAULT_SIZE,watermark:ImageConfig.DEFAULT_WATERMARK},referenceImages:true,sizes:['2K','3K'],maxReferenceImages:14},
    {id:VideoConfig.DEFAULT_MODEL,name:modelName(VideoConfig.DEFAULT_MODEL,'video'),kind:'video',provider:'doubao',default:true,available:true,verified:false,
      defaults:{resolution:VideoConfig.DEFAULT_RESOLUTION,ratio:VideoConfig.DEFAULT_RATIO,duration:VideoConfig.DEFAULT_DURATION,
        watermark:VideoConfig.DEFAULT_WATERMARK,generateAudio:VideoConfig.DEFAULT_GENERATE_AUDIO},referenceImages:true,maxReferenceImages:9,
      referenceModes:['first_frame','first_last_frame','reference_images'],durationRange:[4,15]},
    {id:VIDEO_15,name:'Seedance 1.5 Pro',kind:'video',provider:'doubao',default:false,available:true,verified:false,
      defaults:{resolution:VideoConfig.DEFAULT_RESOLUTION,ratio:VideoConfig.DEFAULT_RATIO,duration:VideoConfig.DEFAULT_DURATION,
        watermark:VideoConfig.DEFAULT_WATERMARK,generateAudio:VideoConfig.DEFAULT_GENERATE_AUDIO},referenceImages:true,maxReferenceImages:2,
      referenceModes:['first_frame','first_last_frame'],source:'coze_documented_integration'},
  ],source:'coze_sdk_and_official_integration_docs',scope:'admin_test',safeCancellation:'before_submission_only'};
}

function providerDetail(value:unknown):string {
  if(!record(value))return '';
  const code=typeof value.code==='string'||typeof value.code==='number'?String(value.code).slice(0,100):'';
  const message=typeof value.message==='string'?value.message.replace(/[\r\n\t]/g,' ')
    .replace(/data:[^\s"'<>]+/gi,'[图片数据]').replace(/https?:\/\/[^\s"'<>]+/gi,'[文件地址]')
    .replace(/\bBearer\s+\S+/gi,'Bearer [隐藏]').replace(/(api[_-]?key|password|secret|token|验证码|密码)\s*[:=]\s*[^\s,;]+/gi,'$1=[隐藏]').slice(0,350):'';
  return [code,message].filter(Boolean).join(' · ');
}
function imageFiles(value:unknown):{files:Record<string,unknown>[];errors:string[]} {
  if(!record(value)||!Array.isArray(value.data)||!value.data.length)fail(502,'MEDIA_GENERATION_FAILED','Coze未提供实际生成图片：'+(record(value)?providerDetail(value.error):''));
  const files:Record<string,unknown>[]=[],errors:string[]=[];
  value.data.forEach((item:unknown,index:number)=>{
    if(!record(item)||item.error||typeof item.url!=='string'||!item.url.startsWith('https://')||item.url.length>8192){
      errors.push(`第${index+1}项：`+(record(item)&&item.error?providerDetail(item.error):'没有可取回的实际文件地址'));return;
    }
    files.push({url:item.url,kind:'image',mimeType:null,name:`生成图片${index+1}`});
  });
  if(!files.length)fail(502,'MEDIA_GENERATION_FAILED',errors.join('；'));
  return {files,errors};
}

async function upstream(config:Awaited<ReturnType<typeof cozeGenerationRuntime>>['config'],method:string,path:string,body:unknown,signal:AbortSignal):Promise<unknown>{
  const base=new URL(config.baseUrl);
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)fail(503,'COZE_MEDIA_NOT_READY','Coze生成服务地址未通过项目身份检查');
  const headers=new Headers(config.getHeaders());headers.set('content-type','application/json');headers.set('accept','application/json');
  headers.set('x-client-sdk','float-ai-coze-media/1');
  let response:Response;
  try{response=await fetch(base.toString().replace(/\/$/u,'')+path,{method,redirect:'error',headers,signal,
    ...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{fail(502,'MEDIA_SUBMISSION_UNKNOWN','Coze生成请求的响应未确认，未自动重复提交');}
  const reader=response.body?.getReader();if(!reader)fail(502,'MEDIA_RESULT_INVALID','Coze生成服务未返回响应');
  const parts:Uint8Array[]=[];let length=0;
  try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;
    if(length>256*1024)fail(502,'MEDIA_RESULT_TOO_LARGE','生成结果元数据超出范围，未截断或当作成功');parts.push(part.value);}}
  finally{await reader.cancel().catch(()=>undefined);reader.releaseLock();}
  const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}
  const raw=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  if(raw.includes(config.apiKey))fail(502,'MEDIA_RESULT_SENSITIVE','平台响应包含不应公开的身份数据，未写入生成记录');
  let value:unknown;try{value=JSON.parse(raw);}catch{fail(502,'MEDIA_RESULT_INVALID','Coze生成响应不是有效JSON');}
  if(!response.ok){
    const error=record(value)&&record(value.error)?value.error:null;
    const rawCode=error?.code;
    const code=typeof rawCode==='string'&&/^[A-Za-z0-9_.-]{1,100}$/.test(rawCode)?rawCode:
      typeof rawCode==='number'&&Number.isSafeInteger(rawCode)?String(rawCode):'UNSPECIFIED';
    const message=response.status===401?'Coze生成服务鉴权失败':response.status===403?'Coze平台拒绝了本次生成访问或输入':
      response.status===404?'Coze生成接口或任务不存在':response.status===429?'Coze生成服务繁忙或限流':
      response.status<500?'Coze没有接受本次生成参数或内容':'Coze生成服务暂时不可用，提交结果可能未确认';
    fail(response.status,'MEDIA_PROVIDER_REJECTED',`${message}（HTTP ${response.status}，${code}）`+(error?'：'+providerDetail(error):''));
  }
  return value;
}

/** Uses the same project identity as SDK clients; creation is one attempt, no hidden paid retries. */
export async function cozeProjectMediaOperation(operation:unknown,input:unknown,parent:AbortSignal):Promise<Record<string,unknown>>{
  if(typeof operation!=='string'||!['models','generate_image','generate_video','video_status'].includes(operation)||!record(input))fail(400,'MEDIA_REQUEST_INVALID','未实现该生成操作');
  const context=await cozeGenerationRuntime();
  if(parent.aborted)fail(499,'ASSISTANT_REQUEST_CANCELLED','生成请求已取消');
  if(operation==='models')return catalogue();
  const timeout=typeof input.timeoutSeconds==='number'&&Number.isSafeInteger(input.timeoutSeconds)&&input.timeoutSeconds>=5&&input.timeoutSeconds<=120?input.timeoutSeconds:45;
  const signal=AbortSignal.any([parent,AbortSignal.timeout(timeout*1000)]);
  if(operation==='video_status'){
    if(typeof input.providerTaskId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(input.providerTaskId))fail(400,'MEDIA_REQUEST_INVALID','视频任务编号格式无效');
    const value=await upstream(context.config,'GET','/api/v3/contents/generations/tasks/'+input.providerTaskId,undefined,signal);
    if(!record(value)||typeof value.status!=='string')fail(502,'MEDIA_RESULT_INVALID','平台未返回实际视频状态');
    if(value.status==='succeeded'){
      if(!record(value.content)||typeof value.content.video_url!=='string'||value.content.video_url.length>8192)fail(502,'MEDIA_RESULT_INVALID','平台标记完成但未返回实际视频文件');
      return {status:value.status,files:[{url:value.content.video_url,kind:'video',mimeType:'video/mp4',name:'生成视频'}]};
    }
    const detail=providerDetail(value.error);
    return {status:value.status,message:value.status==='failed'?'Coze平台视频生成失败；未提供完成的视频文件。'+(detail?' 原因：'+detail:''):undefined};
  }
  const kind=operation==='generate_image'?'image':'video';
  const validated=mediaCreateRequest({jobId:'media_bridge',conversationId:'media_bridge',taskId:'media_bridge',kind,
    modelId:input.modelId,parameters:input.parameters,references:input.references,timeoutSeconds:timeout});
  const expected=validated.modelId;
  const allowed:readonly string[]=kind==='image'?[ImageConfig.DEFAULT_MODEL,IMAGE_45]:[VideoConfig.DEFAULT_MODEL,VIDEO_15];
  if(!allowed.includes(expected))fail(422,'MEDIA_MODEL_UNAVAILABLE','该实际型号尚未接入当前Coze生成适配，未改用其他型号');
  const p=validated.parameters,images=validated.references.map(ref=>`data:${ref.mimeType};base64,${ref.data}`);
  if(kind==='image'){
    if(p.size!==undefined){
      const lite=expected===ImageConfig.DEFAULT_MODEL;
      const presets=lite?['2K','3K']:['2K','4K'];
      if(!presets.includes(p.size)){
        try{validateImageSize(p.size);}catch{fail(400,'MEDIA_REQUEST_INVALID','图片尺寸不符合当前实际型号规则，未回退成其他尺寸');}
        const match=/^(\d+)x(\d+)$/.exec(p.size);
        const pixels=match?Number(match[1])*Number(match[2]):0;
        if(!match||pixels<3686400||pixels>(lite?3072*3072*1.1025:4096*4096))fail(400,'MEDIA_REQUEST_INVALID','所选图片型号不支持该尺寸，未改成其他尺寸');
      }
    }
    const body:Record<string,unknown>=buildImageGenerationApiRequest({prompt:p.prompt,...(p.watermark!==undefined?{watermark:p.watermark}:{}),
      ...(images.length?{image:images.length===1?images[0]:images}:{}),
      ...(p.count!==undefined?{sequentialImageGeneration:p.count>1?'auto':'disabled',sequentialImageGenerationMaxImages:p.count}:{})},expected);
    // SDK0.7.32 silently falls back for 3K. Restore only the explicitly validated actual-model value.
    if(p.size!==undefined)body.size=p.size;
    const response=await upstream(context.config,'POST','/api/v3/images/generations',body,signal);
    return imageFiles(response);
  }
  const referenceMode=p.reference_mode??(images.length===1?'first_frame':'reference_images');
  if(expected===VideoConfig.DEFAULT_MODEL&&p.duration!==undefined&&(p.duration<4||p.duration>15))fail(400,'MEDIA_REQUEST_INVALID','当前Seedance2.0单段时长范围为4–15秒，未改为其他时长；这不是任务总时限');
  if(images.length&&referenceMode==='first_frame'&&images.length!==1)fail(400,'MEDIA_REQUEST_INVALID','首帧模式需要恰好一张参考图');
  if(referenceMode==='first_last_frame'&&images.length!==2)fail(400,'MEDIA_REQUEST_INVALID','首尾帧模式需要按顺序提供两张完整参考图');
  if(expected===VIDEO_15&&images.length&&referenceMode==='reference_images')fail(400,'MEDIA_REQUEST_INVALID','Seedance1.5仅支持首帧或首尾帧模式，未将多张参考图擅自改为其他用途');
  const content:Record<string,unknown>[]=[{type:'text',text:p.prompt}];
  images.forEach((url,index)=>content.push({type:'image_url',image_url:{url},role:referenceMode==='first_last_frame'?(index===0?'first_frame':'last_frame'):
    referenceMode==='first_frame'?'first_frame':'reference_image'}));
  const body={model:expected,content,resolution:p.resolution??VideoConfig.DEFAULT_RESOLUTION,ratio:p.ratio??VideoConfig.DEFAULT_RATIO,
    duration:p.duration??VideoConfig.DEFAULT_DURATION,watermark:p.watermark??VideoConfig.DEFAULT_WATERMARK,camerafixed:VideoConfig.DEFAULT_CAMERA_FIXED,
    generate_audio:p.generate_audio??VideoConfig.DEFAULT_GENERATE_AUDIO};
  const result=await upstream(context.config,'POST','/api/v3/contents/generations/tasks',body,signal);
  if(!record(result)||typeof result.id!=='string')fail(502,'MEDIA_RESULT_INVALID','平台没有返回实际视频任务编号');
  return {providerTaskId:result.id,status:result.status??'queued'};
}

export async function mediaGeneration(request:Request):Promise<Response>{
  try{
    const raw=await readAuthenticatedMediaBody(request);if(raw===null)return denyModelCompletion();
    let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw));}catch{fail(400,'MEDIA_REQUEST_INVALID','媒体请求不是有效JSON');}
    if(!record(value)||Object.keys(value).some(key=>!['operation','input'].includes(key)))fail(400,'MEDIA_REQUEST_INVALID','媒体请求格式无效');
    const result=await cozeProjectMediaOperation(value.operation,value.input,request.signal);
    const context=await cozeGenerationRuntime();
    return Response.json({projectId:PROJECT_ID,environment:context.environment,result},{headers:{'cache-control':'no-store'}});
  }catch(error:unknown){
    let status=503,code='COZE_MEDIA_NOT_READY',message='Coze媒体生成暂不可用';
    if(record(error)&&typeof error.code==='string'&&typeof error.statusCode==='number'&&error instanceof Error){
      status=error.statusCode;code=error.code;message=error.message;
    }else if(record(error)&&typeof error.status==='number'&&typeof error.code==='string'&&typeof error.publicMessage==='string'){
      status=error.status;code=error.code;message=error.publicMessage;
    }
    return Response.json({error:{code,message}},{status,headers:{'cache-control':'no-store'}});
  }
}
