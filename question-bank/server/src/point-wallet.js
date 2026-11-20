import {ApiError,id,sha256} from './security.js';
import {createHash} from 'node:crypto';
import {pointUnits,pointValue,MAX_POINT_VALUE} from './point-values.js';

// Longer than every public Idempotency-Key, matching the existing protected financial keyspaces.
const namespaceHash=value=>createHash('sha256').update(value).digest('hex');
const PREFIX='point_wallet_internal_v1:'+namespaceHash('point-wallet-record-namespace')+':'+namespaceHash('point-wallet-account-namespace')+':';
const ACCOUNT=PREFIX+'account',MAX_UNITS=MAX_POINT_VALUE*100;
const holdKey=key=>PREFIX+'hold:'+sha256(key),creditKey=key=>PREFIX+'credit:'+sha256(key);
const units=(value,zero=true)=>{if(!Number.isSafeInteger(value)||value<(zero?0:1)||value>MAX_UNITS)throw new ApiError(422,'WALLET_AMOUNT_INVALID','点数金额超出范围');return value;};
const decode=(row,type)=>{try{const v=JSON.parse(row.result);if(v.type!==type)throw new Error();return v;}catch{throw new ApiError(500,'WALLET_RECORD_INVALID','点数分账记录无法核实，未修改余额');}};
const sums=state=>state.lots.reduce((a,l)=>({balance:a.balance+l.remainingUnits,reserved:a.reserved+l.reservedUnits}),{balance:0,reserved:0});
const validate=state=>{
  if(state.type!=='point_wallet_v1'||!Array.isArray(state.lots)||!Array.isArray(state.pending)||new Set(state.pending).size!==state.pending.length)throw new ApiError(500,'WALLET_RECORD_INVALID','点数分账状态无效');
  const ids=new Set();for(const l of state.lots){units(l.remainingUnits);units(l.reservedUnits);if(ids.has(l.id)||l.reservedUnits>l.remainingUnits||!['permanent','monthly'].includes(l.kind)||!Number.isSafeInteger(l.startsAt)||l.expiresAt!==null&&!Number.isSafeInteger(l.expiresAt))throw new ApiError(500,'WALLET_RECORD_INVALID','点数批次状态无效');ids.add(l.id);}
  const total=sums(state);units(total.balance);units(total.reserved);return total;
};

/** Active lots are a bounded financial snapshot; immutable credit/hold receipts remain separate rows.
 * All changes use the existing confirmations transactions and normalized points ledger, not client flags.
 */
export function pointWallet(store,{clock=Date.now}={}) {
  const read=async(owner,key)=>store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,key);
  const insert=async(owner,key,digest,value)=>store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',owner,key,digest,JSON.stringify(value));
  const write=async(owner,key,value)=>store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(value),owner,key);
  const getUser=async(owner,lock=false)=>{
    const user=await store.get('SELECT * FROM users WHERE id=?'+(lock&&store.kind==='postgres'?' FOR UPDATE':''),owner);
    if(!user)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');return user;
  };
  const ledger=async(owner,state,delta,actor,reason,key)=>{
    if(!delta)return;
    const after=sums(state).balance,before=after-delta;units(before);units(after);
    await store.run('INSERT INTO points_ledger(id,user_id,delta,balance_before,balance_after,reason,actor_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id('ledger'),owner,pointValue(delta),pointValue(before),pointValue(after),reason,actor??owner,key,clock());
  };
  const initialize=async(owner,user,now)=>{
    const balance=pointUnits(user.points_balance),reserved=pointUnits(user.points_reserved);units(balance);units(reserved);
    const pending=[];
    for(const row of await store.all("SELECT id,request_hash,points_cost FROM ai_requests WHERE user_id=? AND status='pending' AND points_cost>0",owner))
      pending.push({key:'ai-search:'+row.id,digest:row.request_hash,amount:pointUnits(row.points_cost)});
    const financial=await store.all('SELECT idempotency_key,request_hash,result FROM confirmations WHERE owner_id=? AND idempotency_key LIKE ?',owner,'assistant_token_internal_v1:%');
    for(const row of financial){
      let value;try{value=JSON.parse(row.result);}catch{throw new ApiError(500,'WALLET_LEGACY_RESERVATION_INVALID','旧计费预留无法读取，未迁移余额');}
      if(['assistant_token_v1','assistant_media_billing_v1'].includes(value.type)&&(value.reservedUnits??0)>0)
        pending.push({key:row.idempotency_key,digest:row.request_hash,amount:units(value.reservedUnits)});
    }
    if(pending.reduce((sum,p)=>sum+p.amount,0)!==reserved)throw new ApiError(500,'WALLET_LEGACY_RESERVATION_INVALID','旧预留金额与任务记录不一致，请核账后重试');
    const state={type:'point_wallet_v1',version:1,createdAt:now,legacyBalanceUnits:balance,legacyReservedUnits:reserved,
      lots:[{id:'permanent',kind:'permanent',remainingUnits:balance,reservedUnits:reserved,startsAt:0,expiresAt:null,expiredUnits:0}],pending:pending.map(p=>p.key)};
    for(const p of pending)await insert(owner,holdKey(p.key),p.digest,{type:'point_wallet_hold_v1',key:p.key,digest:p.digest,state:'reserved',quotedUnits:p.amount,reservedUnits:p.amount,chargedUnits:0,
      allocations:[{lotId:'permanent',reservedUnits:p.amount,consumedUnits:0,releasedUnits:0}],createdAt:now,legacy:true});
    await insert(owner,ACCOUNT,ACCOUNT,state);return state;
  };
  const expire=async(owner,state,now)=>{
    for(const lot of state.lots){
      if(lot.expiresAt===null||lot.expiresAt>now)continue;
      const amount=lot.remainingUnits-lot.reservedUnits;if(!amount)continue;
      lot.remainingUnits-=amount;lot.expiredUnits=(lot.expiredUnits??0)+amount;
      await ledger(owner,state,-amount,owner,'会员月赠点到期','wallet-expiry:'+lot.id+':'+lot.expiredUnits);
    }
    state.lots=state.lots.filter(l=>l.id==='permanent'||l.remainingUnits>0||l.reservedUnits>0);
  };
  const save=async(owner,state)=>{
    const total=validate(state);await write(owner,ACCOUNT,state);
    const balance=pointValue(total.balance),reserved=pointValue(total.reserved);
    await store.run('UPDATE users SET points_balance=?,points_reserved=?,revision=revision+1 WHERE id=? AND (points_balance<>? OR points_reserved<>?)',balance,reserved,owner,balance,reserved);
  };
  const operation=async(owner,fn)=>store.transaction(async()=>{
    const user=await getUser(owner,true),now=clock();
    const prior=await read(owner,ACCOUNT);const state=prior?decode(prior,'point_wallet_v1'):await initialize(owner,user,now);
    const total=validate(state);
    if(total.balance!==pointUnits(user.points_balance)||total.reserved!==pointUnits(user.points_reserved))throw new ApiError(500,'WALLET_LEGACY_WRITE_DETECTED','点数汇总与分账不一致，未覆盖现有余额');
    await expire(owner,state,now);
    const result=await fn(state,now);
    await save(owner,state);return result;
  });
  const eligible=(state,now)=>state.lots.filter(l=>l.startsAt<=now&&(l.expiresAt===null||l.expiresAt>now)&&l.remainingUnits>l.reservedUnits)
    // Subscription gifts first; within that class spend the earliest expiry first.
    // Existing holds retain their original allocations and are never charged a second time.
    .sort((a,b)=>(a.kind==='monthly'?0:1)-(b.kind==='monthly'?0:1)||
      (a.expiresAt??Number.MAX_SAFE_INTEGER)-(b.expiresAt??Number.MAX_SAFE_INTEGER)||a.startsAt-b.startsAt||a.id.localeCompare(b.id));
  const freeUnits=(state,now)=>eligible(state,now).reduce((sum,l)=>sum+l.remainingUnits-l.reservedUnits,0);
  const allocate=(state,hold,amount,now)=>{
    let left=amount;
    for(const lot of eligible(state,now)){
      const use=Math.min(left,lot.remainingUnits-lot.reservedUnits);if(!use)continue;
      lot.reservedUnits+=use;let allocation=hold.allocations.find(a=>a.lotId===lot.id);
      if(!allocation){allocation={lotId:lot.id,reservedUnits:0,consumedUnits:0,releasedUnits:0};hold.allocations.push(allocation);}
      allocation.reservedUnits+=use;hold.reservedUnits+=use;left-=use;if(!left)break;
    }
    if(left)throw new ApiError(402,'POINTS_REQUIRED','可用点数不足');
  };
  const credit=async(owner,amount,sourceKey,{kind='permanent',startsAt=clock(),expiresAt=null,actor=owner,reason='点数到账',ledgerKey=sourceKey}={})=>operation(owner,async(state,now)=>{
    units(amount,false);if(startsAt>now||!Number.isSafeInteger(startsAt)||expiresAt!==null&&(!Number.isSafeInteger(expiresAt)||expiresAt<=startsAt))throw new ApiError(422,'WALLET_PERIOD_INVALID','赠点周期无效');
    const key=creditKey(sourceKey),digest=sha256(JSON.stringify({amount,kind,startsAt:kind==='permanent'?0:startsAt,expiresAt}));
    const prior=await read(owner,key);
    if(prior){if(prior.request_hash!==digest)throw new ApiError(409,'WALLET_CREDIT_CONFLICT','到账标识已用于其他点数');return decode(prior,'point_wallet_credit_v1');}
    const receipt={type:'point_wallet_credit_v1',kind,grantedUnits:amount,creditedUnits:0,createdAt:now,expiresAt};
    if(expiresAt===null||expiresAt>now){
      let lot=kind==='permanent'?state.lots.find(l=>l.id==='permanent'):null;
      if(!lot){lot={id:sha256(sourceKey),kind,remainingUnits:0,reservedUnits:0,startsAt,expiresAt,expiredUnits:0};state.lots.push(lot);}
      lot.remainingUnits+=amount;validate(state);await ledger(owner,state,amount,actor,reason,ledgerKey);receipt.creditedUnits=amount;
    }
    await insert(owner,key,digest,receipt);return receipt;
  });
  const reserve=async(owner,key,amount,digest=sha256(key))=>operation(owner,async(state,now)=>{
    units(amount);const previous=await read(owner,holdKey(key));
    if(previous){const hold=decode(previous,'point_wallet_hold_v1');if(hold.digest!==digest||hold.quotedUnits!==amount)throw new ApiError(409,'WALLET_HOLD_CONFLICT','预留编号已用于其他预算');return hold;}
    if(freeUnits(state,now)<amount)throw new ApiError(402,'POINTS_REQUIRED','可用点数不足');
    const hold={type:'point_wallet_hold_v1',key,digest,state:'reserved',quotedUnits:amount,reservedUnits:0,chargedUnits:0,allocations:[],createdAt:now};
    allocate(state,hold,amount,now);state.pending.push(key);await insert(owner,holdKey(key),digest,hold);return hold;
  });
  const finish=async(owner,key,amount,{release=false,actor=owner,reason='点数使用',ledgerKey=key}={})=>operation(owner,async(state,now)=>{
    units(amount);const found=await read(owner,holdKey(key));if(!found)throw new ApiError(500,'WALLET_HOLD_MISSING','点数预留记录缺失，未重复扣点');
    const hold=decode(found,'point_wallet_hold_v1');
    if(hold.state!=='reserved'){
      if(!release&&hold.state==='captured'&&hold.chargedUnits!==amount)throw new ApiError(409,'WALLET_SETTLEMENT_CONFLICT','原请求已按其他用量结算');
      return {...hold,settled:hold.state==='captured'};
    }
    if(!release&&amount>hold.reservedUnits+freeUnits(state,now))return {...hold,settled:false,requiredUnits:amount-hold.reservedUnits-freeUnits(state,now)};
    if(!release&&amount>hold.reservedUnits)allocate(state,hold,amount-hold.reservedUnits,now);
    let left=release?0:amount;
    for(const allocation of hold.allocations){
      const lot=state.lots.find(l=>l.id===allocation.lotId);const locked=allocation.reservedUnits;
      if(!lot||lot.reservedUnits<locked||lot.remainingUnits<locked)throw new ApiError(500,'WALLET_ALLOCATION_INVALID','点数预留分配不一致');
      const used=Math.min(left,locked);left-=used;lot.remainingUnits-=used;lot.reservedUnits-=locked;
      allocation.reservedUnits=0;allocation.consumedUnits+=used;allocation.releasedUnits+=locked-used;
    }
    if(left)throw new ApiError(500,'WALLET_ALLOCATION_INVALID','点数预留不足');
    hold.reservedUnits=0;hold.chargedUnits=release?0:amount;hold.state=release?'released':'captured';hold.finishedAt=now;
    state.pending=state.pending.filter(p=>p!==key);
    if(!release)await ledger(owner,state,-amount,actor,reason,ledgerKey);
    await expire(owner,state,now);await write(owner,holdKey(key),hold);return {...hold,settled:!release};
  });
  const snapshot=async owner=>operation(owner,async(state,now)=>{
    const total=sums(state);let permanent=0,monthly=0,monthlyReserved=0,expiredReserved=0,expiresAt=null;
    for(const l of state.lots){if(l.kind==='permanent')permanent+=l.remainingUnits-l.reservedUnits;
      else {monthlyReserved+=l.reservedUnits;if(l.expiresAt<=now)expiredReserved+=l.reservedUnits;else {monthly+=l.remainingUnits-l.reservedUnits;expiresAt=expiresAt===null?l.expiresAt:Math.min(expiresAt,l.expiresAt);}}}
    return {pointsBalance:pointValue(total.balance),pointsReserved:pointValue(total.reserved),pointsAvailable:pointValue(total.balance-total.reserved),
      permanentAvailable:pointValue(permanent),monthlyAvailable:pointValue(monthly),monthlyReserved:pointValue(monthlyReserved),expiredReserved:pointValue(expiredReserved),monthlyExpiresAt:expiresAt};
  });
  const extendMonthly=async(owner,sourceKey,expiresAt,amendmentKey)=>operation(owner,async(state,now)=>{
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=now)throw new ApiError(422,'WALLET_PERIOD_INVALID','顺延后的赠点周期无效');
    const key=PREFIX+'schedule:'+sha256(amendmentKey),digest=sha256(JSON.stringify({sourceKey,expiresAt})),prior=await read(owner,key);
    if(prior){if(prior.request_hash!==digest)throw new ApiError(409,'WALLET_SCHEDULE_CONFLICT','该顺延记录已用于其他周期');return decode(prior,'point_wallet_schedule_v1');}
    const granted=await read(owner,creditKey(sourceKey));
    if(!granted||decode(granted,'point_wallet_credit_v1').kind!=='monthly')throw new ApiError(500,'WALLET_CREDIT_MISSING','原会员赠点记录无法核实');
    const lot=state.lots.find(l=>l.id===sha256(sourceKey));
    if(lot){if(expiresAt<lot.expiresAt)throw new ApiError(422,'WALLET_PERIOD_INVALID','会员赠点不能缩短有效期');lot.expiresAt=expiresAt;}
    const receipt={type:'point_wallet_schedule_v1',sourceKey,expiresAt,remainingUnits:lot?.remainingUnits??0,createdAt:now};
    await insert(owner,key,digest,receipt);return receipt;
  });
  return {snapshot,reserve,extendMonthly,creditPermanent:(owner,amount,key,options)=>credit(owner,amount,key,{...options,kind:'permanent',startsAt:0,expiresAt:null}),
    creditMonthly:(owner,amount,key,startsAt,expiresAt,options)=>credit(owner,amount,key,{...options,kind:'monthly',startsAt,expiresAt}),
    capture:(owner,key,amount,options)=>finish(owner,key,amount,options),release:(owner,key)=>finish(owner,key,0,{release:true}),
    async user(owner){await snapshot(owner);return getUser(owner);}};
}
