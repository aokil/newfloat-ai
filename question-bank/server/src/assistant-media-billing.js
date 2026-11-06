import {ApiError,sha256} from './security.js';
import {points} from './account.js';
import {pointUnits,pointValue,availablePointUnits,availablePoints} from './point-values.js';
import {ASSISTANT_NANOS_PER_CENTIPOINT as CENTIPOINT} from './assistant-token-prices.js';
import {assistantFinancialAccount,MEDIA_FINANCIAL_PREFIX as PREFIX,ASSISTANT_FINANCIAL_ACCOUNT as ACCOUNT} from './assistant-financial-account.js';
import {mediaUsage,mediaCost} from './assistant-media-prices.js';

const terminal=new Set(['succeeded','failed','cancelled','expired']);
const parameterNames=['size','count','resolution','ratio','duration','generate_audio','reference_mode'];
const keyFor=id=>PREFIX+sha256(id);
const pairs=(name,units)=>({[name]:pointValue(units),[name+'Units']:units});
const receipt=(row,user)=>({version:1,mode:'media',jobId:row.jobId,state:row.state,pointsUnitScale:100,
  ...pairs('pointsCharged',row.chargedUnits??0),...pairs('pointsReserved',row.reservedUnits??0),
  ...pairs('requiredPoints',row.requiredUnits??0),...pairs('pointsAvailable',availablePointUnits(user)),
  feeNanoPoints:row.feeNanos??null,carryNanoPoints:row.carryNanos??null,
  estimated:row.quote.estimated,estimatedPoints:pointValue(row.quote.units),
  ...(row.usage?{usage:row.usage}:{}),pricing:row.price});

/** Separate async financial lifecycle. Paid evidence survives deleting a conversation/job. */
export function assistantMediaBilling(store){
  const {read,account,write,getUser}=assistantFinancialAccount(store);
  const find=async(owner,id)=>{
    const found=await read(owner,keyFor(id));
    if(found&&found.value.type!=='assistant_media_billing_v1')throw new ApiError(500,'MEDIA_BILLING_RECORD_INVALID','媒体账单类型无法核实');
    return found;
  };
  const settleKey=async(owner,key)=>store.transaction(async()=>{
    if(!key.startsWith(PREFIX))throw new ApiError(400,'MEDIA_BILLING_RECORD_INVALID','媒体账单编号无效');
    const found=await read(owner,key);if(!found)return null;
    let row=found.value,user=await getUser(owner);
    if(row.type!=='assistant_media_billing_v1')throw new ApiError(500,'MEDIA_BILLING_RECORD_INVALID','媒体账单类型无法核实');
    if(['settled','cancelled'].includes(row.state))return receipt(row,user);
    if(row.feeNanos===undefined||row.usageConflict||!row.providerTerminal)return receipt(row,user);
    if(typeof row.feeNanos!=='string'||!/^\d+$/u.test(row.feeNanos))throw new ApiError(500,'MEDIA_BILLING_RECORD_INVALID','实际媒体费用记录无效');
    const state=await account(owner),total=BigInt(state.carryNanos)+BigInt(row.feeNanos),rawUnits=total/CENTIPOINT;
    if(rawUnits>100_000_000_000n)throw new ApiError(500,'MEDIA_BILLING_RECORD_INVALID','实际媒体费用超出账本范围，待人工核账');
    const units=Number(rawUnits),reserved=row.reservedUnits??0;
    if(pointUnits(user.points_reserved)<reserved)throw new ApiError(500,'MEDIA_BILLING_RESERVATION_INVALID','媒体预留记录不一致，未重复扣点');
    const spendable=availablePointUnits(user)+reserved;
    if(units>spendable){
      // Preserve the existing hold, do not overdraw or call another paid model.
      row={...row,state:'settlement_pending',requiredUnits:units-spendable};
      await write(owner,key,row);return receipt(row,user);
    }
    if(reserved){
      await store.run('UPDATE users SET points_reserved=ROUND(points_reserved-?,2),revision=revision+1 WHERE id=?',pointValue(reserved),owner);
      user=await getUser(owner);
    }
    if(units)await points(store,user,-pointValue(units),owner,'媒体生成 · '+row.price.modelId,key);
    state.carryNanos=String(total%CENTIPOINT);state.pending=state.pending.filter(item=>item!==key);
    row={...row,state:'settled',reservedUnits:0,requiredUnits:0,chargedUnits:units,carryNanos:state.carryNanos,finishedAt:Date.now()};
    await write(owner,ACCOUNT,state);await write(owner,key,row);
    await store.audit(owner,'assistant-media-settled',row.jobId,{modelId:row.price.modelId,state:row.state,usage:row.usage,
      priceVersion:row.price.version,pointsCharged:pointValue(units)});
    return receipt(row,await getUser(owner));
  });
  const recover=async owner=>{
    const current=await read(owner,ACCOUNT);if(!current)return;
    for(const key of current.value.pending)if(key.startsWith(PREFIX))await settleKey(owner,key);
  };
  const begin=async(owner,id,digest,price,quote,parameters)=>store.transaction(async()=>{
    const prior=await find(owner,id);
    if(prior){
      if(prior.row.request_hash!==digest)throw new ApiError(409,'MEDIA_IDEMPOTENCY_CONFLICT','同一生成编号已有不同内容的财务记录');
      return {created:false,billing:receipt(prior.value,await getUser(owner))};
    }
    const state=await account(owner),user=await getUser(owner);
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    for(const pendingKey of state.pending){
      const pending=await read(owner,pendingKey);
      if(pending?.value.state==='settlement_pending'){
        const debt=pending.value,extra=debt.type==='assistant_media_billing_v1'?debt.requiredUnits??0:Math.max(0,(debt.requiredUnits??0)-availablePointUnits(user));
        throw new ApiError(402,'ASSISTANT_POINTS_REQUIRED','已有真实用量待补足点数，请充值后继续；未提交新的生成请求',
          {...pairs('requiredPoints',extra),...pairs('pointsAvailable',availablePointUnits(user)),pointsUnitScale:100});
      }
    }
    const rawUnits=(BigInt(quote.amountNanos)+BigInt(state.carryNanos)+CENTIPOINT-1n)/CENTIPOINT;
    if(rawUnits>100_000_000_000n)throw new ApiError(422,'MEDIA_BUDGET_UNCONFIRMED','生成预留超出账本支持范围，未提交平台');
    const units=Number(rawUnits);
    if(units>availablePointUnits(user))throw new ApiError(402,'ASSISTANT_POINTS_REQUIRED',
      `本次生成需预留${pointValue(units)}点，当前可用${availablePoints(user)}点。请充值后继续，未提交平台或缩减生成参数`,
      {...pairs('requiredPoints',units-availablePointUnits(user)),...pairs('pointsAvailable',availablePointUnits(user)),pointsUnitScale:100,estimated:quote.estimated});
    const safeParameters=Object.fromEntries(parameterNames.filter(name=>Object.hasOwn(parameters,name)).map(name=>[name,parameters[name]]));
    const row={type:'assistant_media_billing_v1',jobId:id,price,quote,parameters:safeParameters,state:'pending',
      reservedUnits:units,chargedUnits:0,requiredUnits:0,submissionAttempted:false,providerTerminal:false,startedAt:Date.now(),nextPollAt:0};
    if(units)await store.run('UPDATE users SET points_reserved=ROUND(points_reserved+?,2),revision=revision+1 WHERE id=?',pointValue(units),owner);
    await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',owner,keyFor(id),digest,JSON.stringify(row));
    state.pending.push(keyFor(id));await write(owner,ACCOUNT,state);
    return {created:true,billing:receipt(row,await getUser(owner))};
  });
  const markAttempted=async(owner,id)=>store.transaction(async()=>{
    const found=await find(owner,id);if(!found)return;
    const row=found.value;
    if(row.state==='cancelled')throw new ApiError(409,'MEDIA_CANCELLED','本次生成已在提交前取消');
    row.submissionAttempted=true;await write(owner,keyFor(id),row);
  });
  const capture=async(owner,id,evidence={},status)=>{
    await store.transaction(async()=>{
      const found=await find(owner,id);if(!found)return;
      const row=found.value;
      if(['settled','cancelled'].includes(row.state))return;
      const meta=evidence.providerMetadata;
      if(meta&&typeof meta==='object'&&!Array.isArray(meta)){
        if(typeof meta.model==='string'&&meta.model!==row.price.modelId)row.usageConflict=true;
        if(typeof meta.generate_audio==='boolean')row.parameters.generate_audio=meta.generate_audio;
      }
      const ids=[evidence.providerTaskId,...(row.price.kind==='video'?[meta?.id]:[])].filter(value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,200}$/u.test(value));
      for(const id of ids){
        if(row.providerTaskId&&row.providerTaskId!==id)row.usageConflict=true;
        else row.providerTaskId=id;
      }
      const effectiveStatus=['queued','running','succeeded','failed','cancelled','expired'].includes(meta?.status)?meta.status:status;
      if(typeof effectiveStatus==='string')row.providerStatus=effectiveStatus;
      const complete=terminal.has(effectiveStatus);
      if(complete)row.providerTerminal=true;
      if(evidence.usage!==undefined){
        try{
          const actual=mediaUsage(evidence.usage,row.price.kind);
          if(row.providerTerminal&&row.usage&&JSON.stringify(row.usage)!==JSON.stringify(actual))row.usageConflict=true;
          // A queued task's optional counters are provisional; only terminal counters are billable.
          if(complete&&!row.usageConflict){
            row.usage=actual;const cost=mediaCost(row.price,actual,row.parameters);
            row.feeNanos=String(cost.nanos);row.rates=cost.rates;row.state='pending';
          }
        }catch{if(complete)row.state='usage_unconfirmed';}
      }
      if(complete&&(row.feeNanos===undefined||row.usageConflict))row.state='usage_unconfirmed';
      await write(owner,keyFor(id),row);
    });
    return settleKey(owner,keyFor(id));
  };
  const cancelBeforeSubmission=async(owner,id,{rejected=false}={})=>store.transaction(async()=>{
    const found=await find(owner,id);if(!found)return null;
    const row=found.value;
    if(['settled','cancelled'].includes(row.state))return receipt(row,await getUser(owner));
    if(row.providerTaskId||row.usage||row.submissionAttempted&&!rejected)return receipt(row,await getUser(owner));
    const state=await account(owner),user=await getUser(owner),reserved=row.reservedUnits??0;
    if(reserved>pointUnits(user.points_reserved))throw new ApiError(500,'MEDIA_BILLING_RESERVATION_INVALID','媒体预留记录不一致');
    if(reserved)await store.run('UPDATE users SET points_reserved=ROUND(points_reserved-?,2),revision=revision+1 WHERE id=?',pointValue(reserved),owner);
    row.state='cancelled';row.reservedUnits=0;row.chargedUnits=0;row.feeNanos='0';row.finishedAt=Date.now();
    state.pending=state.pending.filter(key=>key!==keyFor(id));await write(owner,ACCOUNT,state);await write(owner,keyFor(id),row);
    return receipt(row,await getUser(owner));
  });
  const readReceipt=async(owner,id)=>{const found=await find(owner,id);return found?settleKey(owner,keyFor(id)):null;};
  const legacyReceipt=async(owner,id)=>receipt({jobId:id,state:'legacy_free',feeNanos:'0',quote:{estimated:false,units:0}},await getUser(owner));
  const pendingJobs=async()=>{
    const rows=await store.all('SELECT owner_id,idempotency_key,result FROM confirmations WHERE idempotency_key LIKE ? AND (result LIKE ? OR result LIKE ? OR result LIKE ?)',
      PREFIX+'%','%"state":"pending"%','%"state":"usage_unconfirmed"%','%"state":"settlement_pending"%');
    return rows.map(row=>({owner:row.owner_id,key:row.idempotency_key,...JSON.parse(row.result)}));
  };
  const pollAfter=async(owner,id,when,{expired=false}={})=>store.transaction(async()=>{
    const found=await find(owner,id);if(!found)return;
    const row=found.value;row.nextPollAt=when;if(expired)row.pollExpired=true;await write(owner,keyFor(id),row);
  });
  return {begin,markAttempted,capture,cancelBeforeSubmission,readReceipt,legacyReceipt,recover,settleKey,pendingJobs,pollAfter};
}
