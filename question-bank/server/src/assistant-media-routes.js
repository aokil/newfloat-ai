import {assistantMediaJobs} from './assistant-media-jobs.js';
import {assistantMediaDownload} from './assistant-media-download.js';
import {MEDIA_BODY_LIMIT,mediaJobId} from './assistant-media-contract.js';
import {ApiError} from './security.js';
import {assistantTokenBilling} from './assistant-token-billing.js';

export async function assistantMediaRoutes(app,{store,auth,cozeBridge}){
  const jobs=assistantMediaJobs(store,cozeBridge);
  const priorBilling=assistantTokenBilling(store);
  const admin=async req=>{await auth(req);if(req.auth.role!=='admin')throw new ApiError(403,'ASSISTANT_ADMIN_ONLY','内置生成模型当前仅管理员测试');};
  // Reject non-admin requests before accepting large reference image bodies.
  const options={onRequest:admin,config:{rateLimit:false}};
  const paid=async req=>{
    await admin(req);
    if(req.headers['x-float-media-billing']!=='usage-v1')throw new ApiError(426,'MEDIA_BILLING_CLIENT_REQUIRED',
      '媒体生成已接入真实用量计费，请更新支持费用回执的App；本次未提交生成或扣点');
    await priorBilling.recover(req.auth.user_id);
  };
  let recoveryTask=null;
  const recovery=setInterval(()=>{
    if(!recoveryTask)recoveryTask=jobs.reconcile().then(result=>{
      if(result?.failed)app.log.warn({code:'MEDIA_RECONCILIATION_PENDING',count:result.failed},'Media reconciliation pending');
    }).catch(()=>app.log.error({code:'MEDIA_RECONCILIATION_FAILED'},'Media reconciliation failed')).finally(()=>{recoveryTask=null;});
  },10000);
  recovery.unref();
  const signalFor=(req,reply)=>{
    const controller=new AbortController();
    const stop=()=>{if(!reply.raw.writableEnded)controller.abort();};
    req.raw.once('aborted',stop);reply.raw.once('close',stop);
    return {signal:controller.signal,release:()=>{req.raw.removeListener('aborted',stop);reply.raw.removeListener('close',stop);}};
  };
  app.addHook('onClose',async()=>{clearInterval(recovery);await jobs.close();if(recoveryTask)await recoveryTask;});
  app.get('/v1/assistant/media/models',options,async(req,reply)=>{
    const control=signalFor(req,reply);try{return await jobs.models(control.signal);}finally{control.release();}
  });
  app.post('/v1/assistant/media/jobs',{...options,onRequest:paid,bodyLimit:MEDIA_BODY_LIMIT},async(req,reply)=>{
    const control=signalFor(req,reply);try{return {job:await jobs.create(req.auth.user_id,req.body,control.signal)};}finally{control.release();}
  });
  app.get('/v1/assistant/media/jobs/:jobId',options,async(req,reply)=>{
    const control=signalFor(req,reply);
    try{return {job:await jobs.status(req.auth.user_id,mediaJobId(req.params.jobId),control.signal)};}finally{control.release();}
  });
  app.post('/v1/assistant/media/jobs/:jobId/cancel',options,async req=>({job:await jobs.cancel(req.auth.user_id,mediaJobId(req.params.jobId))}));
  app.delete('/v1/assistant/media/jobs/:jobId',options,async(req,reply)=>{await jobs.forget(req.auth.user_id,mediaJobId(req.params.jobId));reply.code(204).send();});
  app.get('/v1/assistant/media/jobs/:jobId/assets/:index',options,async(req,reply)=>{
    if(!/^\d{1,2}$/u.test(req.params.index))throw new ApiError(400,'MEDIA_FILE_INDEX_INVALID','生成文件编号无效');
    const asset=await jobs.asset(req.auth.user_id,mediaJobId(req.params.jobId),Number(req.params.index));
    const control=signalFor(req,reply);
    try{
      const file=await assistantMediaDownload(asset.url,control.signal);
      reply.header('cache-control','no-store').header('x-content-type-options','nosniff').type(file.mimeType);
      if(file.length&&/^\d+$/u.test(file.length))reply.header('content-length',file.length);
      file.stream.once('close',control.release);file.stream.once('error',control.release);
      return reply.send(file.stream);
    }catch(error){control.release();throw error;}
  });
}
