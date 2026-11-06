import {ApiError,sha256} from './security.js';
import {points} from './account.js';
import {pointUnits,pointValue,availablePointUnits,availablePoints} from './point-values.js';
import {assistantTokenUsage,assistantTokenCost,assistantTokenPricing,ASSISTANT_NANOS_PER_CENTIPOINT} from './assistant-token-prices.js';
import {assistantFinancialAccount,TOKEN_FINANCIAL_PREFIX as PREFIX,MEDIA_FINANCIAL_PREFIX,ASSISTANT_FINANCIAL_ACCOUNT as ACCOUNT} from './assistant-financial-account.js';
import {assistantMediaBilling} from './assistant-media-billing.js';

// Public confirmations use an HTTP path prefix. Financial records instead use a fixed
// internal namespace and digested request IDs, never a caller's raw confirmation key.
const receipt=(row,user)=>({version:1,mode:'token',state:row.state,requestId:row.requestId,
  pointsCharged:pointValue(row.chargedUnits??0),pointsChargedUnits:row.chargedUnits??0,pointsUnitScale:100,
  pointsAvailable:availablePoints(user),pointsAvailableUnits:availablePointUnits(user),
  feeNanoPoints:row.feeNanos??'0',carryNanoPoints:row.carryNanos??'0',
  ...(row.requiredUnits?{requiredPoints:pointValue(row.requiredUnits),requiredPointsUnits:row.requiredUnits}:{}),
  ...(row.usage?{usage:row.usage}:{}),pricing:{version:row.price.version,modelId:row.price.modelId,source:row.price.source,
    currency:'CNY',pointsPerYuan:20,multiplier:'1.4',period:row.price.period,...(row.rates?{rates:row.rates}:{})}});

/** All durable data are financial counters, hashes and snapshots; never prompts, replies or credentials. */
export function assistantTokenBilling(store){
  const {read,account,write,getUser}=assistantFinancialAccount(store);
  const mediaBilling=assistantMediaBilling(store);
  const finish=async(owner,key,{expired=false}={})=>store.transaction(async()=>{
    const found=await read(owner,key);if(!found)throw new ApiError(500,'ASSISTANT_BILLING_RECORD_INVALID','对话计费记录缺失');
    let row=found.value,user=await getUser(owner);
    if(!['pending','settlement_pending'].includes(row.state))return receipt(row,user);
    if(expired&&row.state==='pending'&&row.expiresAt>Date.now())return null;
    const state=await account(owner),reserved=row.reservedUnits??0;
    if(reserved){
      if(pointUnits(user.points_reserved)<reserved)throw new ApiError(500,'ASSISTANT_BILLING_RESERVATION_INVALID','计费预留记录不一致，未重复扣点');
      await store.run('UPDATE users SET points_reserved=ROUND(points_reserved-?,2),revision=revision+1 WHERE id=?',pointValue(reserved),owner);
      row.reservedUnits=0;user=await getUser(owner);
    }
    let cost;
    if(row.usage&&!row.usageUnconfirmed){
      try{cost=assistantTokenCost(row.price,row.usage);}catch{row.usageUnconfirmed=true;}
    }
    if(!cost){
      row={...row,state:'usage_unconfirmed',chargedUnits:0,carryNanos:state.carryNanos,finishedAt:Date.now()};
    }else{
      const total=BigInt(state.carryNanos)+cost.nanos;
      const units=Number(total/ASSISTANT_NANOS_PER_CENTIPOINT);
      row={...row,feeNanos:String(cost.nanos),rates:cost.rates};
      if(units>availablePointUnits(user)){
        // Never make a balance negative. This only covers an upstream budget/counter discrepancy.
        row={...row,state:'settlement_pending',chargedUnits:0,carryNanos:state.carryNanos,requiredUnits:units};
        await write(owner,key,row);
        return receipt(row,user);
      }
      if(units)await points(store,user,-pointValue(units),owner,'对话Token · '+row.price.modelId,key);
      state.carryNanos=String(total%ASSISTANT_NANOS_PER_CENTIPOINT);
      row={...row,state:'settled',chargedUnits:units,requiredUnits:0,carryNanos:state.carryNanos,finishedAt:Date.now()};
      user=await getUser(owner);
    }
    state.pending=state.pending.filter(item=>item!==key);
    await write(owner,ACCOUNT,state);await write(owner,key,row);
    await store.audit(owner,'assistant-token-settled',row.requestId,{state:row.state,modelId:row.price.modelId,
      pointsCharged:pointValue(row.chargedUnits),...(row.usage?{usage:row.usage}:{}),priceVersion:row.price.version});
    return receipt(row,user);
  });
  const recover=async owner=>{
    const found=await read(owner,ACCOUNT);if(!found)return;
    for(const key of found.value.pending){
      if(key.startsWith(MEDIA_FINANCIAL_PREFIX))await mediaBilling.settleKey(owner,key);
      else await finish(owner,key,{expired:true});
    }
  };
  const recoverExpired=async()=>{
    const rows=await store.all('SELECT owner_id FROM confirmations WHERE idempotency_key=? AND result LIKE ?',ACCOUNT,'%"pending":["%');
    for(const row of rows)await recover(row.owner_id);
  };
  const begin=async(owner,requestId,digest,price,quote,timeoutSeconds)=>{
    await recover(owner);
    const key=PREFIX+sha256(requestId);
    await store.transaction(async()=>{
      const prior=await read(owner,key);
      if(prior){
        if(prior.row.request_hash!==digest)throw new ApiError(409,'ASSISTANT_IDEMPOTENCY_CONFLICT','同一请求编号不能用于不同对话或模型');
        throw new ApiError(409,prior.value.state==='pending'?'ASSISTANT_REQUEST_PENDING':'ASSISTANT_REQUEST_RECORDED',
          prior.value.state==='pending'?'原请求仍在处理，未再次调用或扣点':'原请求已有计费记录，未再次调用模型；请查看原任务或重新发送消息',
          {billing:receipt(prior.value,await getUser(owner))});
      }
      const user=await getUser(owner),state=await account(owner);
      const requiredUnits=Number((BigInt(quote.amountNanos)+BigInt(state.carryNanos)+ASSISTANT_NANOS_PER_CENTIPOINT-1n)/ASSISTANT_NANOS_PER_CENTIPOINT);
      if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
      for(const pendingKey of state.pending){
        const debt=(await read(owner,pendingKey))?.value;
        if(debt?.state==='settlement_pending'){
          const media=debt.type==='assistant_media_billing_v1';
          throw new ApiError(402,'ASSISTANT_POINTS_REQUIRED','已有真实用量待结算，请充值后继续；未下发新的模型请求',media?
            {pointsBudgetScope:'media',requiredPoints:pointValue(debt.requiredUnits??0),requiredPointsUnits:debt.requiredUnits??0,
              pointsAvailable:availablePoints(user),pointsAvailableUnits:availablePointUnits(user),pointsUnitScale:100}:undefined);
        }
      }
      if(availablePointUnits(user)<requiredUnits)throw new ApiError(402,'ASSISTANT_POINTS_REQUIRED',
        `当前点数不足以覆盖保留的单轮预算（需预留${pointValue(requiredUnits)}点，可用${availablePoints(user)}点）。预留不是实际扣费；请充值后继续，未缩减输出预算或调用模型`,
        {requiredPoints:pointValue(requiredUnits),pointsAvailable:availablePoints(user),budgetSource:quote.budgetSource,
          outputTokenBudget:quote.outputTokenBudget,estimated:true});
      const row={type:'assistant_token_v1',requestId,state:'pending',price,quote,reservedUnits:requiredUnits,
        chargedUnits:0,usage:null,startedAt:Date.now(),expiresAt:Date.now()+timeoutSeconds*1000+30000};
      await store.run('UPDATE users SET points_reserved=ROUND(points_reserved+?,2),revision=revision+1 WHERE id=?',pointValue(requiredUnits),owner);
      await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',owner,key,digest,JSON.stringify(row));
      state.pending.push(key);await write(owner,ACCOUNT,state);
    });
    const captureUsage=async(raw,metadata={})=>store.transaction(async()=>{
      const found=await read(owner,key);if(!found||found.value.state!=='pending')return;
      const row=found.value;
      let usage;
      try{usage=assistantTokenUsage(raw);}catch{row.usageUnconfirmed=true;await write(owner,key,row);return;}
      if(row.usage&&JSON.stringify(row.usage)!==JSON.stringify(usage)){
        row.usageUnconfirmed=true;row.usageConflict=true;await write(owner,key,row);return;
      }
      const created=metadata.created;
      if(row.price.execution==='official'&&Number.isSafeInteger(created)&&created>0&&Math.abs(created*1000-row.startedAt)<300000){
        row.price=assistantTokenPricing({execution:'official',provider:row.price.provider,modelId:row.price.modelId,baseUrl:'https://api.deepseek.com'},created*1000);
      }
      row.usage=usage;row.usageUnconfirmed=row.usageConflict===true;await write(owner,key,row);
    });
    return {captureUsage,finish:()=>finish(owner,key)};
  };
  return {begin,recover,recoverExpired};
}
