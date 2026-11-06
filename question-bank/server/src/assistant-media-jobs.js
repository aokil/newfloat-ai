import {ApiError} from './security.js';
import {mediaCreateRequest,mediaJobId,mediaPublicJob} from './assistant-media-contract.js';
import {assistantMediaBilling} from './assistant-media-billing.js';
import {mediaPricing,mediaEffectiveParameters,mediaQuote} from './assistant-media-prices.js';

const PREFIX='assistant_media_v1:';
const pending=new Set(['submitting','queued','running','unknown']);

/** Display jobs can be deleted; independent financial evidence and provider IDs survive. */
export function assistantMediaJobs(store,bridge,{billing=assistantMediaBilling(store)}={}){
  const active=new Map(),operations=new Set(),refreshes=new Map(),pollControllers=new Set();let creating=0,closed=false;
  const transact=operation=>billing?store.transaction(operation):operation();
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
  const publicJob=async(owner,job)=>{
    const result=mediaPublicJob(job);
    if(job.billingVersion==='usage-v1'){
      const bill=await billing.readReceipt(owner,job.jobId);
      if(!bill)throw new ApiError(500,'MEDIA_BILLING_RECORD_INVALID','媒体财务记录暂不可核对，未重新生成');
      result.billing=bill;
    }else if(billing)result.billing=await billing.readReceipt(owner,job.jobId)??await billing.legacyReceipt(owner,job.jobId);
    return result;
  };
  const work=async(owner,id,request)=>{
    const controller=new AbortController();active.set(owner+':'+id,controller);
    try{
      let {job}=await read(owner,id);
      if(job.cancelRequested||job.status==='cancelled'){await billing?.cancelBeforeSubmission(owner,id);return;}
      await patch(owner,id,{status:'submitting',message:'正在向Coze提交生成请求。'});
      // Mark the uncertain boundary before sending. Never automatically retry a paid creation.
      job=await transact(async()=>{
        const current=(await read(owner,id)).job;
        if(current.cancelRequested||current.status==='cancelled')return current;
        await billing?.markAttempted(owner,id);
        return patch(owner,id,{submissionAttempted:true});
      });
      if(job.cancelRequested||job.status==='cancelled'){await billing?.cancelBeforeSubmission(owner,id);await patch(owner,id,{status:'cancelled',providerSubmitted:false,message:'已在提交平台前取消。'});return;}
      const result=await call(request.kind==='image'?'generate_image':'generate_video',
        {modelId:job.modelId,parameters:request.parameters,references:request.references,timeoutSeconds:request.timeoutSeconds},controller.signal);
      if(request.kind==='image'){
        const completed=result.status!=='failed'&&Array.isArray(result.files)&&result.files.length>0;
        // Real generation counters are durable before validating delivery URLs/files.
        await billing?.capture(owner,id,result,completed?'succeeded':'failed');
        if(!completed){await patch(owner,id,{status:'failed',providerSubmitted:true,errorCode:result.errorCode??'MEDIA_RESULT_INVALID',
          message:result.message??'平台未提供可取回的生成图片；费用按实际用量回执单独核账。'});return;}
        if(!Array.isArray(result.files)||!result.files.length)throw new ApiError(502,'MEDIA_RESULT_INVALID','平台没有返回实际生成图片');
        const partialErrors=Array.isArray(result.errors)?result.errors.filter(item=>typeof item==='string'):[];
        await patch(owner,id,{status:'succeeded',providerSubmitted:true,outputs:result.files,partialErrors,
          message:(request.parameters.count&&result.files.length!==request.parameters.count?
            `平台实际生成${result.files.length}张，用户要求${request.parameters.count}张；未伪造其余图片。`:'图片已由Coze生成，等待下载到App。')+
            (partialErrors.length?` ${partialErrors.length}项未完成：${partialErrors.join('；')}`:'')});
      }else{
        await billing?.capture(owner,id,result,result.status??'queued');
        if(typeof result.providerTaskId!=='string'||!/^[A-Za-z0-9_-]{1,200}$/u.test(result.providerTaskId))throw new ApiError(502,'MEDIA_RESULT_INVALID','平台未返回可查询的视频任务编号');
        await patch(owner,id,{providerTaskId:result.providerTaskId,providerSubmitted:true,status:result.status==='running'?'running':'queued',message:'视频任务已提交，不代表已生成完成。'});
      }
    }catch(error){
      const evidence=error instanceof ApiError?error.details?.mediaEvidence:undefined;
      try{
        await billing?.capture(owner,id,evidence??{},request.kind==='image'&&(evidence?.usage||error?.code==='MEDIA_GENERATION_FAILED')?'failed':evidence?.providerMetadata?.status);
        if(error instanceof ApiError&&!evidence?.usage&&!evidence?.providerMetadata?.id&&(error.code==='MEDIA_PROVIDER_REJECTED'&&error.statusCode>=400&&error.statusCode<500||
          ['MEDIA_REQUEST_INVALID','MEDIA_MODEL_UNAVAILABLE','COZE_MEDIA_NOT_READY'].includes(error.code)))
          await billing?.cancelBeforeSubmission(owner,id,{rejected:true});
      }catch{/* Keep persisted evidence/hold for a later reconciliation attempt. */}
      const uncertain=controller.signal.aborted||!(error instanceof ApiError)||error.statusCode>=500&&error.code!=='MEDIA_GENERATION_FAILED';
      try{await patch(owner,id,{status:uncertain?'unknown':'failed',errorCode:error instanceof ApiError?error.code:'MEDIA_SUBMISSION_UNKNOWN',
        message:uncertain?(error instanceof ApiError?error.message+'。':'')+'平台提交结果暂未确认，已保留任务记录；未自动重试，以免重复生成。':error.message});}catch{}
    }finally{active.delete(owner+':'+id);}
  };
  const refreshVideo=async(owner,id,providerTaskId)=>{
    const key=owner+':'+id;
    if(refreshes.has(key))return refreshes.get(key);
    const controller=new AbortController();pollControllers.add(controller);
    const operation=(async()=>{
      let result;
      try{result=await call('video_status',{providerTaskId,timeoutSeconds:45},controller.signal);}
      catch(error){
        if(error instanceof ApiError&&error.details?.mediaEvidence)await billing?.capture(owner,id,error.details.mediaEvidence,error.details.mediaEvidence.providerMetadata?.status);
        await billing?.pollAfter(owner,id,Date.now()+30000,{expired:error instanceof ApiError&&error.statusCode===404});
        throw error;
      }
      const knownStatus=['queued','running','succeeded','failed','cancelled','expired'].includes(result.status);
      await billing?.capture(owner,id,{...result,providerTaskId},knownStatus?result.status:undefined);
      if(!knownStatus)throw new ApiError(502,'MEDIA_RESULT_INVALID','平台返回未知视频状态，未当作完成');
      await billing?.pollAfter(owner,id,Date.now()+10000);
      const status=result.status==='expired'?'failed':result.status;
      const delivered=status==='succeeded'&&Array.isArray(result.files)&&result.files.length>0;
      const finalStatus=status==='succeeded'&&!delivered?'failed':status;
      try{
        return await patch(owner,id,current=>({providerTaskId,providerSubmitted:true,...(current.status==='succeeded'?(delivered?{outputs:result.files,message:'视频已生成，平台文件链接已刷新。'}:{}):
          !pending.has(current.status)&&!(current.status==='failed'&&current.errorCode==='MEDIA_RESULT_INVALID'&&delivered)?{}:{status:finalStatus,...(delivered?{outputs:result.files,errorCode:null}:{}),
            ...(result.status==='expired'?{errorCode:'MEDIA_GENERATION_EXPIRED'}:result.errorCode?{errorCode:result.errorCode}:{}),
            message:result.message??(result.status==='expired'?'平台视频任务已过期，未提供完成文件。':delivered?'视频已生成，等待下载到App。':
              finalStatus==='failed'?'平台未提供可取回的完成视频，费用按真实回执单独核账。':status==='cancelled'?'平台已取消视频生成。':'视频正在平台排队或生成中。')} )}));
      }catch(error){if(error instanceof ApiError&&error.code==='MEDIA_JOB_NOT_FOUND')return null;throw error;}
    })();
    refreshes.set(key,operation);
    try{return await operation;}finally{refreshes.delete(key);pollControllers.delete(controller);}
  };
  return {
    models:async signal=>{
      const value=await call('models',{},signal);
      return {...value,items:(value.items??[]).map(item=>{
        try{return {...item,billing:mediaPricing(item.id,item.kind)};}
        catch{return {...item,available:false,unavailableReason:'MEDIA_PRICE_UNAVAILABLE'};}
      }),billing:{version:1,mode:'media',requiresClientHeader:'usage-v1'}};
    },
    async create(owner,input,signal){
      ensure();const request=mediaCreateRequest(input),key=PREFIX+request.jobId;
      let existing=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
      if(existing){if(existing.request_hash!==request.digest&&existing.request_hash!=='cancelled-before-create')throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','同一生成任务编号不能用于不同要求或参考图');return publicJob(owner,(await read(owner,request.jobId)).job);}
      if(active.size+creating>=4)throw new ApiError(429,'ASSISTANT_BUSY','当前生成请求正在处理，请等待已有任务；本次尚未提交平台');
      creating++;
      try{
      const catalogue=await call('models',{},AbortSignal.timeout(15000));
      signal?.throwIfAborted();
      const selected=catalogue.items?.find(item=>item.kind===request.kind&&(request.modelId?item.id===request.modelId:item.default===true));
      if(!selected||selected.available!==true)throw new ApiError(422,'MEDIA_MODEL_UNAVAILABLE','所选生成模型不在当前已接入的Coze能力列表中');
      const price=mediaPricing(selected.id,request.kind),parameters=mediaEffectiveParameters(price,request.parameters,request.references),quote=mediaQuote(price,parameters);
      if(billing&&request.priceVersion!==price.version)throw new ApiError(422,'MEDIA_PRICE_CHANGED','媒体价目已更新，请重新打开模型列表确认后再生成；本次未提交平台');
      if(billing)await billing.recover(owner);
      const now=Date.now(),job={type:'assistant_media_v1',jobId:request.jobId,conversationId:request.conversationId,taskId:request.taskId,
        kind:request.kind,modelId:selected.id,status:'queued',createdAt:now,updatedAt:now,timeoutSeconds:request.timeoutSeconds,
        requestedCount:parameters.count??null,...(billing?{billingVersion:'usage-v1'}:{}),providerSubmitted:false,outputs:[],message:'后台已接收，尚未确认平台生成结果。'};
      const inserted=await transact(async()=>{
        const prior=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
        if(prior){if(prior.request_hash!==request.digest&&prior.request_hash!=='cancelled-before-create')throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','生成编号已有其他内容');return {changes:0};}
        const reserved=await billing?.begin(owner,request.jobId,request.digest,price,quote,parameters);
        if(reserved&&!reserved.created)throw new ApiError(409,'MEDIA_JOB_RECORDED','该生成编号已有独立财务记录，未再次提交；请查询原任务或发送新的需求',{billing:reserved.billing});
        return store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',owner,key,request.digest,JSON.stringify(job));
      });
      if(inserted.changes===1){
        if(signal?.aborted){await billing?.cancelBeforeSubmission(owner,request.jobId);await patch(owner,request.jobId,{status:'cancelled',cancelRequested:true,message:'生成请求在提交平台前已取消。'});}
        else{const operation=work(owner,request.jobId,{...request,parameters});operations.add(operation);void operation.finally(()=>operations.delete(operation));}
      }else{existing=await read(owner,request.jobId);if(existing.row.request_hash!==request.digest&&existing.row.request_hash!=='cancelled-before-create')throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','生成任务编号已被其他内容使用');}
      return publicJob(owner,(await read(owner,request.jobId)).job);
      }finally{creating--;}
    },
    async status(owner,id,signal){
      let {job}=await read(owner,id);
      if(job.kind==='video'&&job.providerTaskId&&(pending.has(job.status)||job.status==='succeeded'||job.status==='failed'&&job.errorCode==='MEDIA_RESULT_INVALID')){
        try{job=await refreshVideo(owner,id,job.providerTaskId)??job;}
        catch(error){if(job.status==='succeeded')return publicJob(owner,{...job,message:'已记录平台生成完成；本次未能刷新平台链接，已取回的本机文件仍可使用。'});throw error;}
      }else if(!job.providerTaskId&&['queued','submitting'].includes(job.status)&&Date.now()-job.updatedAt>(job.timeoutSeconds+10)*1000&&!active.has(owner+':'+id)){
        job=await patch(owner,id,{status:'unknown',errorCode:'MEDIA_SUBMISSION_UNKNOWN',message:'提交过程已中断，未取得可查询的平台编号；未自动重复生成。'});
      }
      return publicJob(owner,job);
    },
    async cancel(owner,id){
      mediaJobId(id);
      const now=Date.now(),tombstone={type:'assistant_media_v1',jobId:id,conversationId:'',taskId:'',kind:'unknown',modelId:'',status:'cancelled',
        cancelRequested:true,providerSubmitted:false,createdAt:now,updatedAt:now,outputs:[],message:'已在生成请求被接收前取消。'};
      await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',
        owner,PREFIX+id,'cancelled-before-create',JSON.stringify(tombstone));
      const {job}=await read(owner,id);
      if(!pending.has(job.status))return {...await publicJob(owner,job),cancelled:job.status==='cancelled'};
      // Provider DELETE also deletes completed results; do not race it against completion.
      const next=await transact(async()=>{
        const changed=await patch(owner,id,current=>!pending.has(current.status)?{}:!current.submissionAttempted?
          {cancelRequested:true,status:'cancelled',message:'已在提交平台前取消。'}:
          {cancelRequested:true,message:'已停止后续执行；当前平台接口无法保证安全取消，生成和计费记录已保留，可稍后从历史取回。'});
        if(changed.status==='cancelled')await billing?.cancelBeforeSubmission(owner,id);
        return changed;
      });
      return {...await publicJob(owner,next),cancelled:next.status==='cancelled'};
    },
    async asset(owner,id,index){
      const {job}=await read(owner,id);
      if(job.status!=='succeeded'||!Number.isSafeInteger(index)||index<0||index>=(job.outputs?.length??0))throw new ApiError(404,'MEDIA_FILE_NOT_READY','该生成文件尚未完成或不存在');
      return job.outputs[index];
    },
    async forget(owner,id){
      await this.cancel(owner,id);
      await store.run('DELETE FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,PREFIX+mediaJobId(id));
    },
    async reconcile(){
      if(!billing||closed)return;
      let failed=0;
      for(const row of await billing.pendingJobs()){
        if(closed)break;
        try{
          if(row.feeNanos!==undefined&&row.providerTerminal&&!row.usageConflict){await billing.settleKey(row.owner,row.key);continue;}
          if(!row.submissionAttempted&&Date.now()-row.startedAt>150000&&!active.has(row.owner+':'+row.jobId)){
            await billing.cancelBeforeSubmission(row.owner,row.jobId);continue;
          }
          if(row.price.kind==='video'&&row.providerTaskId&&!row.pollExpired&&row.nextPollAt<=Date.now()){
            if(Date.now()-row.startedAt>7*86400000){await billing.pollAfter(row.owner,row.jobId,0,{expired:true});continue;}
            await refreshVideo(row.owner,row.jobId,row.providerTaskId);
          }
        }catch{failed++;/* Retain the hold/evidence, never recreate a paid job. */}
      }
      return {failed};
    },
    async close(){closed=true;for(const controller of active.values())controller.abort();for(const controller of pollControllers)controller.abort();await Promise.allSettled([...operations,...refreshes.values()]);},
  };
}
