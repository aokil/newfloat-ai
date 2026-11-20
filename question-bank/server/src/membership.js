import {createHash} from 'node:crypto';
import {ApiError,sha256,fields} from './security.js';
import {pointWallet} from './point-wallet.js';

const hash=v=>createHash('sha256').update(v).digest('hex');
const PREFIX='membership_internal_v1:'+hash('membership-records')+':'+hash('membership-accounts')+':';
const ACCOUNT=PREFIX+'account',orderKey=id=>PREFIX+'order:'+sha256(id),jobKey=id=>PREFIX+'import:'+sha256(id);
const offerKey=id=>PREFIX+'offer:'+sha256(id);
const EXCHANGE_POINTS=5,EXCHANGE_UNITS=500;
const importHoldKey=(jobId,sourceHash)=>PREFIX+'import-exchange:'+sha256(jobId+'\u0000'+sourceHash);
export const MEMBERSHIP_PLANS=Object.freeze([
  Object.freeze({id:'membership-go',plan:'go',title:'Go 月度会员',amountMinor:1600,points:120,aiImports:5,allowPointsExchange:true,pointsPerImportExchange:EXCHANGE_POINTS,importLimit:5000,libraryCapacity:20000,historyLimit:1500,masterEngine:true,moveArrows:true,automaticMoves:true,miniBoard:false,replay:false,cloudEngine:false}),
  Object.freeze({id:'membership-plus',plan:'plus',title:'Plus 月度会员',amountMinor:2660,points:320,aiImports:15,allowPointsExchange:true,pointsPerImportExchange:EXCHANGE_POINTS,importLimit:10000,libraryCapacity:30000,historyLimit:3000,masterEngine:true,moveArrows:true,automaticMoves:true,miniBoard:true,replay:true,cloudEngine:false})
]);
export const membershipPlan=id=>MEMBERSHIP_PLANS.find(p=>p.id===id||p.plan===id)??null;
const base={plan:'free',allowPointsExchange:false,pointsPerImportExchange:EXCHANGE_POINTS,importLimit:3000,libraryCapacity:10000,historyLimit:500,masterEngine:false,moveArrows:true,automaticMoves:false,miniBoard:false,replay:false,cloudEngine:false};
const count=n=>Number.isSafeInteger(n)&&n>=0&&n<=1_000_000_000;
// Subscription calendar is Asia/Shanghai (CNY billing), retaining the original day across short months.
export function nextMembershipMonth(timestamp,anchorDay){
  const offset=8*3600000,d=new Date(timestamp+offset),y=d.getUTCFullYear(),m=d.getUTCMonth()+1;
  const day=Math.min(anchorDay,new Date(Date.UTC(y,m+1,0)).getUTCDate());
  return Date.UTC(y,m,day,d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds())-offset;
}
const decode=(row,type)=>{try{const v=JSON.parse(row.result);if(v.type!==type)throw new Error();return v;}catch{throw new ApiError(500,'MEMBERSHIP_RECORD_INVALID','会员权益记录无法核实，请稍后重试');}};

/** Authoritative periods and cumulative import quota. Old free/sponsor labels never grant a paid plan. */
export function membershipAccount(store,{clock=Date.now}={}){
  const wallet=pointWallet(store,{clock});
  const read=async(owner,key)=>store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
  const write=async(owner,key,value)=>store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(value),owner,key);
  const insert=async(owner,key,digest,value)=>store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',owner,key,digest,JSON.stringify(value));
  const transaction=async(owner,fn)=>store.transaction(async()=>{
    const user=await store.get('SELECT * FROM users WHERE id=?'+(store.kind==='postgres'?' FOR UPDATE':''),owner);
    if(!user)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    const now=clock(),found=await read(owner,ACCOUNT);
    const state=found?decode(found,'membership_account_v1'):{type:'membership_account_v1',version:1,initialGranted:2,granted:2,used:0,reserved:0,periods:[],createdAt:now};
    if(![state.granted,state.used,state.reserved].every(count)||state.used+state.reserved>state.granted||!Array.isArray(state.periods))throw new ApiError(500,'MEMBERSHIP_RECORD_INVALID','导题额度记录无法核实');
    if(!found)await insert(owner,ACCOUNT,ACCOUNT,state);
    for(const period of state.periods){
      if(period.startsAt>now||period.issued)continue;
      const plan=period.benefits;
      await wallet.creditMonthly(owner,plan.points*100,'membership-cycle:'+period.orderId,period.startsAt,period.endsAt,
        {reason:plan.title+'月赠点',ledgerKey:'membership-cycle:'+period.orderId});
      state.granted+=plan.aiImports;if(!count(state.granted))throw new ApiError(422,'MEMBERSHIP_QUOTA_LIMIT','累计导题额度超出范围');
      period.issued=true;
    }
    // Immutable order receipts retain expired periods; the active account snapshot stays bounded.
    state.periods=state.periods.filter(p=>!p.issued||p.endsAt>now);
    const result=await fn(state,now,user);await write(owner,ACCOUNT,state);return result;
  });
  const describe=(state,now)=>{
    const current=state.periods.find(p=>p.startsAt<=now&&now<p.endsAt),upcoming=state.periods.filter(p=>p.startsAt>now).sort((a,b)=>a.startsAt-b.startsAt);
    // Account-wide library capacity and per-file import limit are distinct. Old paid receipts stay immutable.
    const policy=current?membershipPlan(current.benefits.plan):null;
    const benefits=current?{...base,...current.benefits,importLimit:policy?.importLimit??base.importLimit,
      libraryCapacity:policy?.libraryCapacity??base.libraryCapacity,
      moveArrows:policy?.moveArrows??base.moveArrows,automaticMoves:policy?.automaticMoves??base.automaticMoves,
      allowPointsExchange:policy?.allowPointsExchange??base.allowPointsExchange,pointsPerImportExchange:EXCHANGE_POINTS}:base;
    return {...benefits,version:1,active:!!current,expiresAt:current?new Date(current.endsAt).toISOString():null,
      subscriptionExpiresAt:state.periods.length?new Date(Math.max(...state.periods.map(p=>p.endsAt))).toISOString():null,
      nextPlan:upcoming[0]?.benefits.plan??null,nextPlanStartsAt:upcoming[0]?new Date(upcoming[0].startsAt).toISOString():null,
      aiImports:{initial:state.initialGranted,granted:state.granted,used:state.used,reserved:state.reserved,available:state.granted-state.used-state.reserved},
      cloudEngineStatus:'not_connected',billingTimezone:'Asia/Shanghai'};
  };
  const snapshot=owner=>transaction(owner,(state,now)=>describe(state,now));
  const quota=owner=>transaction(owner,async(state,now,user)=>{
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    const membership=describe(state,now),balance=await wallet.snapshot(owner);
    const subscriptionActive=membership.active&&['go','plus'].includes(membership.plan);
    // A quota read carries no account/offline-validUntil and cannot extend a client permission lease.
    return {aiImports:membership.aiImports,pointsAvailable:balance.pointsAvailable,subscriptionActive,plan:membership.plan,
      exchangePolicy:{allowed:subscriptionActive&&membership.allowPointsExchange,pointsPerImport:EXCHANGE_POINTS,defaultEnabled:true}};
  });
  const fulfill=async(owner,orderId,planId)=>transaction(owner,async(state,now,user)=>{
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    const offer=await read(owner,offerKey(orderId));
    const plan=offer?decode(offer,'membership_offer_v1').benefits:membershipPlan(planId);
    if(!plan||plan.id!==membershipPlan(planId)?.id)throw new ApiError(400,'MEMBERSHIP_PLAN_INVALID','会员等级不存在');
    const key=orderKey(orderId),digest=sha256(plan.id),prior=await read(owner,key);
    if(prior){if(prior.request_hash!==digest)throw new ApiError(409,'MEMBERSHIP_ORDER_CONFLICT','该订单已有其他会员权益');return decode(prior,'membership_order_v1');}
    const ordered=state.periods.filter(p=>p.endsAt>now).sort((a,b)=>a.startsAt-b.startsAt),current=ordered.find(p=>p.startsAt<=now&&now<p.endsAt);
    const rank=p=>p==='plus'?2:p==='go'?1:0;
    let startsAt=ordered.at(-1)?.endsAt??now,anchorDay=ordered.at(-1)?.anchorDay??new Date(now+8*3600000).getUTCDate();
    if(current&&rank(plan.plan)>rank(current.benefits.plan)){
      startsAt=now;anchorDay=new Date(now+8*3600000).getUTCDate();
    }else if(current?.benefits.plan===plan.plan){
      let last=current;
      for(const next of ordered.filter(p=>p.startsAt>=current.endsAt)){if(next.benefits.plan!==plan.plan)break;last=next;}
      startsAt=last.endsAt;anchorDay=last.anchorDay;
    }
    const period={orderId,startsAt,endsAt:nextMembershipMonth(startsAt,anchorDay),anchorDay,benefits:{...plan},issued:false};
    const duration=period.endsAt-period.startsAt;
    for(const priorPeriod of state.periods.filter(p=>p.endsAt>startsAt)){
      priorPeriod.startsAt=Math.max(priorPeriod.startsAt,startsAt)+duration;priorPeriod.endsAt+=duration;
      priorPeriod.anchorDay=new Date(priorPeriod.endsAt+8*3600000).getUTCDate();
      if(priorPeriod.issued)await wallet.extendMonthly(owner,'membership-cycle:'+priorPeriod.orderId,priorPeriod.endsAt,'membership-reschedule:'+orderId+':'+priorPeriod.orderId);
    }
    state.periods.push(period);
    const receipt={type:'membership_order_v1',fulfilled:true,orderId,plan:plan.plan,startsAt:new Date(period.startsAt).toISOString(),endsAt:new Date(period.endsAt).toISOString(),benefits:{...plan},createdAt:now};
    await insert(owner,key,digest,receipt);
    if(startsAt<=now){
      await wallet.creditMonthly(owner,plan.points*100,'membership-cycle:'+orderId,period.startsAt,period.endsAt,{reason:plan.title+'月赠点',ledgerKey:'membership-cycle:'+orderId});
      state.granted+=plan.aiImports;period.issued=true;
    }
    await store.run('UPDATE users SET revision=revision+1 WHERE id=?',owner);return receipt;
  });
  const freezeOffer=async(owner,orderId,plan)=>{
    if(!membershipPlan(plan.id))throw new ApiError(400,'MEMBERSHIP_PLAN_INVALID','会员等级不存在');
    const key=offerKey(orderId),digest=sha256(JSON.stringify(plan)),prior=await read(owner,key);
    if(prior){if(prior.request_hash!==digest)throw new ApiError(409,'MEMBERSHIP_ORDER_CONFLICT','订单权益快照不一致');return;}
    await insert(owner,key,digest,{type:'membership_offer_v1',version:1,benefits:{...plan}});
  };
  const orderReceipt=async(owner,orderId)=>{
    const found=await read(owner,orderKey(orderId));if(!found)return null;
    const original=decode(found,'membership_order_v1');
    return transaction(owner,(state,now)=>{
      const period=state.periods.find(p=>p.orderId===orderId);
      return {...original,effectiveStartsAt:period?new Date(period.startsAt).toISOString():original.startsAt,
        effectiveEndsAt:period?new Date(period.endsAt).toISOString():original.endsAt,
        activation:period?(period.startsAt>now?'scheduled':'active'):'completed'};
    });
  };
  const readTicket=found=>{
    const ticket=decode(found,'membership_import_v1'),funding=ticket.funding??'quota';
    if(!['quota','points'].includes(funding)||funding==='points'&&ticket.pointsCost!==EXCHANGE_POINTS)
      throw new ApiError(500,'MEMBERSHIP_RECORD_INVALID','导题资金来源记录无法核实');
    return {...ticket,funding,pointsCost:funding==='points'?EXCHANGE_POINTS:0,
      pointsCharged:funding==='points'&&ticket.state==='consumed'?EXCHANGE_POINTS:0,
      pointsReserved:funding==='points'&&ticket.state==='reserved'?EXCHANGE_POINTS:0};
  };
  const startImport=async(owner,jobId,sourceHash,allowPointsExchange=false)=>transaction(owner,async(state,now,user)=>{
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    if(typeof jobId!=='string'||!/^[a-f0-9-]{36}$/u.test(jobId)||typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(sourceHash))throw new ApiError(400,'AI_IMPORT_JOB_INVALID','导题任务标识无效');
    if(typeof allowPointsExchange!=='boolean')throw new ApiError(400,'INVALID_REQUEST','allowPointsExchange必须为布尔值');
    const key=jobKey(jobId),prior=await read(owner,key);
    if(prior){const v=readTicket(prior);if(v.sourceHash!==sourceHash)throw new ApiError(409,'AI_IMPORT_JOB_CONFLICT','导题任务已绑定其他文件');return v;}
    const membership=describe(state,now);let funding='quota';
    if(state.granted-state.used-state.reserved<1){
      if(!allowPointsExchange)throw new ApiError(403,'AI_IMPORT_QUOTA_REQUIRED','AI导题可用次数已用完或已被其他任务预留；可开通或续费会员补充次数');
      if(!membership.active||!['go','plus'].includes(membership.plan)||!membership.allowPointsExchange)
        throw new ApiError(403,'AI_IMPORT_EXCHANGE_UNAVAILABLE','仅有效Go或Plus订阅可在次数用尽时允许点数兑换次数');
      try {await wallet.reserve(owner,importHoldKey(jobId,sourceHash),EXCHANGE_UNITS,sha256(JSON.stringify({jobId,sourceHash,points:EXCHANGE_POINTS})));}
      catch(error){if(error instanceof ApiError&&error.code==='POINTS_REQUIRED')throw new ApiError(402,'AI_IMPORT_EXCHANGE_POINTS_REQUIRED','可用点数不足5点，未兑换导题次数');throw error;}
      funding='points';
    }
    const ticket={type:'membership_import_v1',jobId,sourceHash,state:'reserved',questionLimit:membership.importLimit,createdAt:now,
      funding,pointsCost:funding==='points'?EXCHANGE_POINTS:0,allowPointsExchange};
    if(funding==='quota')state.reserved++;
    await insert(owner,key,sha256(sourceHash),ticket);return readTicket({result:JSON.stringify(ticket)});
  });
  const finishImport=async(owner,jobId,success,sourceHash=undefined)=>transaction(owner,async(state,now)=>{
    if(sourceHash!==undefined&&(typeof jobId!=='string'||!/^[a-f0-9-]{36}$/u.test(jobId)||typeof sourceHash!=='string'||!/^[a-f0-9]{64}$/u.test(sourceHash)))
      throw new ApiError(400,'AI_IMPORT_JOB_INVALID','导题任务或原文件指纹无效');
    const key=jobKey(jobId),found=await read(owner,key);
    if(!found){
      if(success!==false||sourceHash===undefined)throw new ApiError(404,'AI_IMPORT_JOB_NOT_FOUND','未找到导题授权记录');
      // Cancellation may beat a still-in-flight start. Bind the file before any future reservation can occur.
      const stopped={type:'membership_import_v1',jobId,sourceHash,state:'released',questionLimit:describe(state,now).importLimit,
        createdAt:now,finishedAt:now,funding:'quota',allowPointsExchange:false,pointsCost:0,pointsReserved:0,pointsCharged:0};
      await insert(owner,key,sha256(sourceHash),stopped);return stopped;
    }
    const ticket=readTicket(found);
    if(sourceHash!==undefined&&ticket.sourceHash!==sourceHash)throw new ApiError(409,'AI_IMPORT_JOB_CONFLICT','导题任务已绑定其他文件');
    if(ticket.state==='reserved'){
      if(ticket.funding==='points'){
        const hold=importHoldKey(jobId,ticket.sourceHash);
        if(success){
          const receipt=await wallet.capture(owner,hold,EXCHANGE_UNITS,{reason:'AI导入 · 点数兑换次数',ledgerKey:hold});
          if(!receipt.settled||receipt.chargedUnits!==EXCHANGE_UNITS)throw new ApiError(409,'AI_IMPORT_EXCHANGE_UNSETTLED','本次导题点数预留尚未完成结算，请恢复原任务');
        }else{
          const receipt=await wallet.release(owner,hold);
          if(receipt.state!=='released')throw new ApiError(409,'AI_IMPORT_EXCHANGE_UNSETTLED','本次导题已有结算记录，未重复释放');
        }
      }else{
        if(state.reserved<1)throw new ApiError(500,'MEMBERSHIP_RECORD_INVALID','导题预留记录不一致');
        state.reserved--;if(success)state.used++;
      }
      ticket.state=success?'consumed':'released';ticket.finishedAt=now;
      ticket.pointsReserved=0;ticket.pointsCharged=success&&ticket.funding==='points'?EXCHANGE_POINTS:0;
      await write(owner,key,ticket);
    }else if(success&&ticket.state==='released')throw new ApiError(409,'AI_IMPORT_JOB_RELEASED','本次导题已取消，请新建任务');
    return ticket;
  });
  const requireImport=async(owner,jobId,sourceHash)=>{
    const found=await read(owner,jobKey(jobId??''));if(!found)throw new ApiError(403,'AI_IMPORT_TICKET_REQUIRED','请更新App并从AI导入入口授权本次文件');
    const ticket=readTicket(found);
    if(ticket.sourceHash!==sourceHash||!['reserved','consumed'].includes(ticket.state))throw new ApiError(403,'AI_IMPORT_TICKET_INVALID','本次文件的导题授权无效');return ticket;
  };
  return {snapshot,quota,fulfill,freezeOffer,orderReceipt,startImport,finishImport,requireImport};
}

export async function membershipRoutes(app,{store,auth}){
  const members=membershipAccount(store);
  app.get('/v1/memberships/catalog',{preHandler:auth},async()=>({version:1,currency:'CNY',items:MEMBERSHIP_PLANS,cloudEngineStatus:'not_connected'}));
  app.get('/v1/memberships/ai-imports/quota',{preHandler:auth},req=>members.quota(req.auth.user_id));
  app.post('/v1/memberships/ai-imports/:id/start',{preHandler:auth,bodyLimit:1024},async req=>{
    fields(req.body,['sourceHash','allowPointsExchange']);
    const ticket=await members.startImport(req.auth.user_id,req.params.id,req.body.sourceHash,req.body.allowPointsExchange);
    const latest=await members.quota(req.auth.user_id);
    return {...ticket,aiImports:latest.aiImports,pointsAvailable:latest.pointsAvailable};
  });
  app.post('/v1/memberships/ai-imports/:id/finish',{preHandler:auth,bodyLimit:1024},async req=>{
    fields(req.body,['success','sourceHash']);
    if(typeof req.body?.success!=='boolean')throw new ApiError(400,'INVALID_REQUEST','导题结果标记无效');
    const ticket=await members.finishImport(req.auth.user_id,req.params.id,req.body.success,req.body.sourceHash);
    const latest=await members.quota(req.auth.user_id);
    return {...ticket,aiImports:latest.aiImports,pointsAvailable:latest.pointsAvailable};
  });
}
