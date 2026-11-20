import {ApiError,id,sha256,text} from './security.js';
import {importRepairRequest,importRepairResult,importRepairModel} from './import-repair.js';
import {membershipAccount} from './membership.js';

const PREFIX='import-repair-v1:',TIMEOUT=90000;
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
/** Existing durable confirmations storage, separate namespace, no points/reservations/ledger writes. */
export function importRepairJobs(store,bridge,{timeoutMs=TIMEOUT}={}){
  const active=new Map();let closed=false;
  const read=async(owner,key)=>{const row=await store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);return row?{...row,value:JSON.parse(row.result)}:null;};
  const write=async(owner,key,value)=>store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(value),owner,key);
  const receipt=async(owner,key)=>{
    const row=await read(owner,key);if(!row)throw new ApiError(404,'IMPORT_REPAIR_NOT_FOUND','未找到本次AI修正请求');
    if(row.value.state==='processing'&&row.value.expiresAt<=Date.now()){
      row.value={...row.value,state:'unknown',error:{code:'IMPORT_REPAIR_OUTCOME_UNKNOWN',message:'此前请求结果未确认，不会自动再次调用；请保留本机结果'}};
      await write(owner,key,row.value);
    }
    return row.value;
  };
  return {
    async get(owner,key){const alias=await read(owner,PREFIX+'key:'+sha256(text(key,'Idempotency-Key',1,128)));if(!alias)throw new ApiError(404,'IMPORT_REPAIR_NOT_FOUND','未找到本次AI修正请求');return receipt(owner,alias.value.jobKey);},
    async create(owner,key,raw){
      if(closed)throw new ApiError(503,'IMPORT_REPAIR_UNAVAILABLE','AI修正服务正在停止');
      const input=importRepairRequest(raw),digest=sha256(canonical(input)),jobKey=PREFIX+'job:'+digest,aliasKey=PREFIX+'key:'+sha256(text(key,'Idempotency-Key',1,128));
      // Persist aliases too: a changed body with an existing key never starts a second request.
      const initial=await store.transaction(async()=>{
        const alias=await read(owner,aliasKey);if(alias&&alias.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','请求标识已用于其他异常内容');
        const existing=await read(owner,jobKey);
        if(!alias)await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',owner,aliasKey,digest,JSON.stringify({jobKey}));
        const bound=await read(owner,aliasKey);if(bound?.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','请求标识已用于其他异常内容');
        if(existing)return {existing:true};
        if(active.size>=4||[...active.values()].some(v=>v.owner===owner))throw new ApiError(429,'IMPORT_REPAIR_BUSY','已有AI修正处理中，请先等待当前异常组');
        const value={schemaVersion:1,requestId:id('repair'),state:'processing',createdAt:Date.now(),expiresAt:Date.now()+timeoutMs,modelId:null,providerRequestId:null,usage:null};
        const saved=await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?) ON CONFLICT(owner_id,idempotency_key) DO NOTHING',owner,jobKey,digest,JSON.stringify(value));
        return saved.changes===0?{existing:true}:{value};
      });
      if(initial.existing)return receipt(owner,jobKey);
      const slot=owner+'|'+jobKey,controller=new AbortController();active.set(slot,{owner,controller});
      let submitted=false,value=initial.value;
      const timer=setTimeout(()=>controller.abort(),timeoutMs);timer.unref?.();
      try{
        if(!bridge?.ready||typeof bridge.importRepair!=='function')throw new ApiError(503,'IMPORT_REPAIR_UNAVAILABLE','后台尚未接入AI异常修正，本机结果已保留');
        value.modelId=importRepairModel(await bridge.metadata());
        if(controller.signal.aborted)throw new ApiError(504,'IMPORT_REPAIR_PREPARATION_TIMEOUT','准备AI修正超时，尚未提交模型');
        await write(owner,jobKey,value);
        const operation=bridge.importRepair(value.modelId,input,{requestId:value.requestId,signal:controller.signal,onSubmitted:()=>{submitted=true;}});
        const outcome=await Promise.race([operation,new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(new ApiError(504,'IMPORT_REPAIR_OUTCOME_UNKNOWN','请求结果未确认，不会再次发送')),{once:true}))]);
        if(!outcome?.usage||!['inputTokens','outputTokens','totalTokens'].every(k=>Number.isSafeInteger(outcome.usage[k])&&outcome.usage[k]>=0)||outcome.usage.totalTokens!==outcome.usage.inputTokens+outcome.usage.outputTokens)
          throw new ApiError(502,'IMPORT_REPAIR_USAGE_MISSING','模型未返回完整真实用量，未采纳修正');
        const observed={usage:outcome.usage,providerRequestId:typeof outcome.providerRequestId==='string'?outcome.providerRequestId:null};
        value={...value,...observed};await write(owner,jobKey,value);
        const result=importRepairResult(outcome.result,input);
        value={...value,state:'completed',result,completedAt:Date.now()};
      }catch(error){
        const known=error instanceof ApiError;
        value={...value,state:submitted?'unknown':'failed',error:{code:known?error.code:'IMPORT_REPAIR_UNAVAILABLE',message:known?error.message:'AI修正服务暂不可用，本机结果已保留'}};
      }finally{clearTimeout(timer);active.delete(slot);}
      await write(owner,jobKey,value);return value;
    },
    close(){closed=true;for(const entry of active.values())entry.controller.abort();},
  };
}
export async function importRepairRoutes(app,{store,auth,cozeBridge=null}){
  const jobs=importRepairJobs(store,cozeBridge);app.addHook('onClose',async()=>jobs.close());
  app.get('/v1/ai/import-repair/receipt',{preHandler:auth},req=>jobs.get(req.auth.user_id,req.headers['idempotency-key']));
  app.post('/v1/ai/import-repair',{preHandler:auth,bodyLimit:128*1024},async req=>{
    const {importJobId,...input}=req.body??{};
    await membershipAccount(store).requireImport(req.auth.user_id,importJobId,input.sourceHash);
    return jobs.create(req.auth.user_id,req.headers['idempotency-key'],input);
  });
}
