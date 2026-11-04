import {ApiError} from './security.js';
import {mediaCreateRequest,mediaJobId,mediaPublicJob} from './assistant-media-contract.js';

const PREFIX='assistant_media_v1:';
const pending=new Set(['submitting','queued','running','unknown']);

/** Durable owner-scoped jobs in the existing generic idempotency store; no billing/schema changes. */
export function assistantMediaJobs(store,bridge){
  const active=new Map(),operations=new Set();let creating=0;
  const read=async(owner,id)=>{
    const row=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,PREFIX+mediaJobId(id));
    if(!row)throw new ApiError(404,'MEDIA_JOB_NOT_FOUND','未找到当前账号的生成任务');
    let job;try{job=JSON.parse(row.result);}catch{throw new ApiError(500,'MEDIA_JOB_RECORD_INVALID','生成任务记录无法读取');}
    if(job.type!=='assistant_media_v1'||job.jobId!==id)throw new ApiError(500,'MEDIA_JOB_RECORD_INVALID','生成任务记录类型不一致');
    return {row,job};
  };
  const patch=async(owner,id,change)=>{
    for(let attempt=0;attempt<5;attempt++){
      const {row,job}=await read(owner,id),next={...job,...(typeof change==='function'?change(job):change),updatedAt:Date.now()};
      const result=await store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=? AND result=?',
        JSON.stringify(next),owner,PREFIX+id,row.result);
      if(result.changes===1)return next;
    }
    throw new ApiError(409,'MEDIA_JOB_CHANGED','生成任务状态正在更新，请重试查询');
  };
  const ensure=()=>{if(!bridge?.ready||typeof bridge.media!=='function')throw new ApiError(503,'COZE_MEDIA_NOT_READY','Coze图片/视频生成桥接尚未更新或授权尚未就绪');};
  const call=(operation,input,signal)=>{ensure();return bridge.media(operation,input,signal);};
  const work=async(owner,id,request)=>{
    const controller=new AbortController();active.set(owner+':'+id,controller);
    try{
      let {job}=await read(owner,id);
      if(job.cancelRequested||job.status==='cancelled')return;
      await patch(owner,id,{status:'submitting',message:'正在向Coze提交生成请求。'});
      // Mark the uncertain boundary before sending. Never automatically retry a paid creation.
      job=await patch(owner,id,current=>current.cancelRequested?{}:{submissionAttempted:true});
      if(job.cancelRequested){await patch(owner,id,{status:'cancelled',providerSubmitted:false,message:'已在提交平台前取消。'});return;}
      const result=await call(request.kind==='image'?'generate_image':'generate_video',
        {modelId:job.modelId,parameters:request.parameters,references:request.references,timeoutSeconds:request.timeoutSeconds},controller.signal);
      if(request.kind==='image'){
        if(!Array.isArray(result.files)||!result.files.length)throw new ApiError(502,'MEDIA_RESULT_INVALID','平台没有返回实际生成图片');
        const partialErrors=Array.isArray(result.errors)?result.errors.filter(item=>typeof item==='string'):[];
        await patch(owner,id,{status:'succeeded',providerSubmitted:true,outputs:result.files,partialErrors,
          message:(request.parameters.count&&result.files.length!==request.parameters.count?
            `平台实际生成${result.files.length}张，用户要求${request.parameters.count}张；未伪造其余图片。`:'图片已由Coze生成，等待下载到App。')+
            (partialErrors.length?` ${partialErrors.length}项未完成：${partialErrors.join('；')}`:'')});
      }else{
        if(typeof result.providerTaskId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/u.test(result.providerTaskId))throw new ApiError(502,'MEDIA_RESULT_INVALID','平台未返回可查询的视频任务编号');
        await patch(owner,id,{providerTaskId:result.providerTaskId,providerSubmitted:true,status:result.status==='running'?'running':'queued',message:'视频任务已提交，不代表已生成完成。'});
      }
    }catch(error){
      const uncertain=controller.signal.aborted||!(error instanceof ApiError)||error.statusCode>=500&&error.code!=='MEDIA_GENERATION_FAILED';
      try{await patch(owner,id,{status:uncertain?'unknown':'failed',errorCode:error instanceof ApiError?error.code:'MEDIA_SUBMISSION_UNKNOWN',
        message:uncertain?(error instanceof ApiError?error.message+'。':'')+'平台提交结果暂未确认，已保留任务记录；未自动重试，以免重复生成。':error.message});}catch{}
    }finally{active.delete(owner+':'+id);}
  };
  return {
    models:signal=>call('models',{},signal),
    async create(owner,input,signal){
      ensure();const request=mediaCreateRequest(input),key=PREFIX+request.jobId;
      let existing=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
      if(existing){if(existing.request_hash!==request.digest&&existing.request_hash!=='cancelled-before-create')throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','同一生成任务编号不能用于不同要求或参考图');return mediaPublicJob((await read(owner,request.jobId)).job);}
      if(active.size+creating>=4)throw new ApiError(429,'ASSISTANT_BUSY','当前生成请求正在处理，请等待已有任务；本次尚未提交平台');
      creating++;
      try{
      const catalogue=await call('models',{},AbortSignal.timeout(15000));
      signal?.throwIfAborted();
      const selected=catalogue.items?.find(item=>item.kind===request.kind&&(request.modelId?item.id===request.modelId:item.default===true));
      if(!selected||selected.available!==true)throw new ApiError(422,'MEDIA_MODEL_UNAVAILABLE','所选生成模型不在当前已接入的Coze能力列表中');
      const now=Date.now(),job={type:'assistant_media_v1',jobId:request.jobId,conversationId:request.conversationId,taskId:request.taskId,
        kind:request.kind,modelId:selected.id,status:'queued',createdAt:now,updatedAt:now,timeoutSeconds:request.timeoutSeconds,
        requestedCount:request.parameters.count??null,providerSubmitted:false,outputs:[],message:'后台已接收，尚未确认平台生成结果。'};
      const inserted=await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',
        owner,key,request.digest,JSON.stringify(job));
      if(inserted.changes===1){
        if(signal?.aborted)await patch(owner,request.jobId,{status:'cancelled',cancelRequested:true,message:'生成请求在提交平台前已取消。'});
        else{const operation=work(owner,request.jobId,request);operations.add(operation);void operation.finally(()=>operations.delete(operation));}
      }else{existing=await read(owner,request.jobId);if(existing.row.request_hash!==request.digest&&existing.row.request_hash!=='cancelled-before-create')throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','生成任务编号已被其他内容使用');}
      return mediaPublicJob((await read(owner,request.jobId)).job);
      }finally{creating--;}
    },
    async status(owner,id,signal){
      let {job}=await read(owner,id);
      if(job.kind==='video'&&job.providerTaskId&&(pending.has(job.status)||job.status==='succeeded')){
        let result;
        try{result=await call('video_status',{providerTaskId:job.providerTaskId,timeoutSeconds:45},signal);}
        catch(error){if(job.status==='succeeded')return mediaPublicJob({...job,message:'已记录平台生成完成；本次未能刷新平台链接，已取回的本机文件仍可使用。'});throw error;}
        if(!['queued','running','succeeded','failed','cancelled','expired'].includes(result.status))throw new ApiError(502,'MEDIA_RESULT_INVALID','平台返回未知视频状态，未当作完成');
        const status=result.status==='expired'?'failed':result.status;
        if(status==='succeeded'&&(!Array.isArray(result.files)||!result.files.length))throw new ApiError(502,'MEDIA_RESULT_INVALID','平台未返回实际生成的视频文件');
        job=await patch(owner,id,current=>current.status==='succeeded'?(status==='succeeded'?{outputs:result.files,message:'视频已生成，平台文件链接已刷新。'}:{}):!pending.has(current.status)?{}:{status,...(status==='succeeded'?{outputs:result.files}:{}),
          ...(result.status==='expired'?{errorCode:'MEDIA_GENERATION_EXPIRED'}:{}),
          message:result.message??(result.status==='expired'?'平台视频任务已过期，未提供完成文件。':status==='succeeded'?'视频已生成，等待下载到App。':status==='failed'?'平台视频生成失败。':status==='cancelled'?'平台已取消视频生成。':'视频正在平台排队或生成中。')});
      }else if(!job.providerTaskId&&['queued','submitting'].includes(job.status)&&Date.now()-job.updatedAt>(job.timeoutSeconds+10)*1000&&!active.has(owner+':'+id)){
        job=await patch(owner,id,{status:'unknown',errorCode:'MEDIA_SUBMISSION_UNKNOWN',message:'提交过程已中断，未取得可查询的平台编号；未自动重复生成。'});
      }
      return mediaPublicJob(job);
    },
    async cancel(owner,id){
      mediaJobId(id);
      const now=Date.now(),tombstone={type:'assistant_media_v1',jobId:id,conversationId:'',taskId:'',kind:'unknown',modelId:'',status:'cancelled',
        cancelRequested:true,providerSubmitted:false,createdAt:now,updatedAt:now,outputs:[],message:'已在生成请求被接收前取消。'};
      await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',
        owner,PREFIX+id,'cancelled-before-create',JSON.stringify(tombstone));
      const {job}=await read(owner,id);
      if(!pending.has(job.status))return {...mediaPublicJob(job),cancelled:job.status==='cancelled'};
      // Provider DELETE also deletes completed results; do not race it against completion.
      const next=await patch(owner,id,current=>!pending.has(current.status)?{}:!current.submissionAttempted?
        {cancelRequested:true,status:'cancelled',message:'已在提交平台前取消。'}:
        {cancelRequested:true,message:'已停止后续执行；当前平台接口无法保证安全取消，生成记录已保留，可稍后从历史取回。'});
      return {...mediaPublicJob(next),cancelled:next.status==='cancelled'};
    },
    async asset(owner,id,index){
      const {job}=await read(owner,id);
      if(job.status!=='succeeded'||!Number.isSafeInteger(index)||index<0||index>=(job.outputs?.length??0))throw new ApiError(404,'MEDIA_FILE_NOT_READY','该生成文件尚未完成或不存在');
      return job.outputs[index];
    },
    async forget(owner,id){await store.run('DELETE FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,PREFIX+mediaJobId(id));},
    async close(){for(const controller of active.values())controller.abort();await Promise.allSettled([...operations]);},
  };
}
