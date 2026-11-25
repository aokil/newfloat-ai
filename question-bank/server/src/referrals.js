import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import {ApiError,fields,id,sha256} from './security.js';
import {pointValue} from './point-values.js';
import {points} from './account.js';

const DAY=86_400_000, CUTOVER=15*3_600_000; // 23:00 in UTC+08:00.
const REWARD=200, MIN_WITHDRAWAL=4000, MAX_OPERATION=20_000_000_000;
export const referralCodePattern=/^[A-Za-z0-9_-]{43}$/u;
export const referralPeriod=now=>Math.floor((now-CUTOVER)/DAY)*DAY+CUTOVER;
const dayDate=start=>new Date(start+DAY+8*3_600_000).toISOString().slice(0,10);
const bad=message=>new ApiError(400,'INVALID_REFERRAL_REQUEST',message);
const missing=()=>new ApiError(404,'NOT_FOUND','记录不存在');
const money=value=>{
  const units=Number(value);
  if(!Number.isSafeInteger(units)||units<0)throw new ApiError(500,'REFERRAL_LEDGER_INVALID','收益金额暂无法核对');
  return units;
};

export async function bindReferral(store,friend,code,now){
  if(typeof code!=='string'||!referralCodePattern.test(code))return;
  const owner=await store.get(`SELECT u.id FROM referral_codes c JOIN users u ON u.id=c.owner_id
    WHERE c.code=? AND u.role='user' AND u.disabled=0`,code);
  if(owner&&owner.id!==friend)await store.run(
    'INSERT INTO referral_attributions(friend_id,owner_id,registered_at,period_start) VALUES(?,?,?,?)',friend,owner.id,now,referralPeriod(now));
}

export async function creditReferralOrder(store,order,now){
  if(order.environment!=='production'||!Number.isSafeInteger(Number(order.amount_minor))||Number(order.amount_minor)<=0)return;
  const row=await store.get('SELECT owner_id FROM referral_attributions WHERE friend_id=? AND registered_at<=?',order.owner_id,now);
  if(row)await store.run('INSERT INTO referral_earnings(id,owner_id,friend_id,kind,units,created_at) VALUES(?,?,?,?,?,?)',
    order.id,row.owner_id,order.owner_id,'commission',Number(order.amount_minor),now);
}

async function paidForPeriod(store,owner,start){
  const totals=await store.get(`SELECT COUNT(*) AS registrations, COALESCE(SUM(CASE WHEN EXISTS (
    SELECT 1 FROM referral_earnings e JOIN payment_orders p ON p.id=e.id
    WHERE e.friend_id=a.friend_id AND e.owner_id=a.owner_id AND e.kind='commission'
    AND e.created_at>=? AND e.created_at<? AND (p.error_code IS NULL OR p.error_code<>'PAYMENT_REFUND_REVIEW_REQUIRED')
  ) THEN 1 ELSE 0 END),0) AS paid FROM referral_attributions a WHERE a.owner_id=? AND a.period_start=?`,start,start+DAY,owner,start);
  return {registrations:Number(totals.registrations),paid:Number(totals.paid)};
}

async function settlePeriod(store,owner,start,now){
  const {registrations,paid}=await paidForPeriod(store,owner,start);
  if(registrations&&paid*10>=registrations)await store.run(`INSERT INTO referral_earnings(id,owner_id,friend_id,kind,units,created_at)
    SELECT 'daily:' || friend_id,owner_id,friend_id,'daily',?,? FROM referral_attributions WHERE owner_id=? AND period_start=?`,REWARD,now,owner,start);
  await store.run('INSERT INTO referral_periods(owner_id,period_start,registrations,paid,settled_at) VALUES(?,?,?,?,?)',owner,start,registrations,paid,now);
}

export async function settleReferralPeriods(store,now=Date.now(),owner=null){
  return store.transaction(async()=>{
    const filter=owner?' AND a.owner_id=?':'';
    const limit=owner?'':' LIMIT 100';
    const rows=await store.all(`SELECT DISTINCT a.owner_id,a.period_start FROM referral_attributions a
      WHERE a.period_start<?${filter} AND NOT EXISTS(SELECT 1 FROM referral_periods s WHERE s.owner_id=a.owner_id AND s.period_start=a.period_start)
      ORDER BY a.period_start,a.owner_id${limit}`,referralPeriod(now),...(owner?[owner]:[]));
    for(const row of rows)await settlePeriod(store,row.owner_id,Number(row.period_start),now);
  });
}

const activeEarned=`(e.kind='daily' OR NOT EXISTS(SELECT 1 FROM payment_orders p WHERE p.id=e.id AND p.error_code='PAYMENT_REFUND_REVIEW_REQUIRED'))`;
async function cashSummary(store,owner){
  const earned=await store.get(`SELECT COALESCE(SUM(e.units),0) AS units FROM referral_earnings e WHERE e.owner_id=? AND ${activeEarned}`,owner);
  const operations=await store.get('SELECT COALESCE(SUM(units),0) AS units FROM referral_cash_operations WHERE owner_id=?',owner);
  const totalUnits=money(earned.units),usedUnits=money(operations.units);
  return {totalUnits,availableUnits:Math.max(0,totalUnits-usedUnits)};
}

function datePeriod(value,current){
  if(value===undefined)return current;
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(value))throw bad('日期格式无效');
  const date=Date.parse(`${value}T23:00:00+08:00`)-DAY;
  if(!Number.isFinite(date)||date>current||dayDate(date)!==value)throw bad('日期超出范围');
  return date;
}

function imageBytes(value){
  if(typeof value!=='string'||value.length>699052||!/^[A-Za-z0-9+/]+={0,2}$/u.test(value))throw bad('请上传 512 KB 以内的 PNG 收款码');
  const decoded=Buffer.from(value,'base64');
  if(decoded.length<45||decoded.length>524288||decoded.toString('base64')!==value||
    decoded.subarray(0,16).toString('hex')!=='89504e470d0a1a0a0000000d49484452'||
    decoded.readUInt32BE(16)<1||decoded.readUInt32BE(16)>1024||decoded.readUInt32BE(20)<1||decoded.readUInt32BE(20)>1024||
    decoded.subarray(-12).toString('hex')!=='0000000049454e44ae426082')throw bad('收款码图片格式无效');
  return decoded;
}

function qrVault(secret){
  const key=secret?.length>=32?createHash('sha256').update('float-ai/referral-withdrawal/v1\0').update(secret).digest():null;
  const needed=()=>{if(!key)throw new ApiError(503,'WITHDRAWAL_UNAVAILABLE','提现暂不可用');};
  return {
    available:!!key,
    encode(image,owner){needed();const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);
      cipher.setAAD(Buffer.from(owner));const data=Buffer.concat([cipher.update(image),cipher.final()]);
      return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');},
    decode(value,owner){needed();const raw=Buffer.from(value,'base64');const cipher=createDecipheriv('aes-256-gcm',key,raw.subarray(0,12));
      cipher.setAAD(Buffer.from(owner));cipher.setAuthTag(raw.subarray(12,28));
      return Buffer.concat([cipher.update(raw.subarray(28)),cipher.final()]).toString('base64');}
  };
}

const abandonKey=key=>`referral-abandon:v1:${sha256(key)}`;
const receipt=row=>({id:row.id,units:money(row.units),status:row.status,createdAt:Number(row.created_at),
  processedAt:row.processed_at===null?null:Number(row.processed_at)});
const mask=phone=>{const parts=/^\+86(\d{3})\d{4}(\d{4})$/u.exec(phone??'');return parts?`${parts[1]}****${parts[2]}`:'****';};
const offsetValue=value=>{const offset=Number(value??0);if(!Number.isSafeInteger(offset)||offset<0)throw bad('分页无效');return offset;};

export function registerReferralRoutes(app,{store,auth,admin,distribution,secret,clock=Date.now}){
  const vault=qrVault(secret);
  const userOnly={preHandler:async req=>{await auth(req);if(req.auth.role!=='user')throw new ApiError(403,'FORBIDDEN','仅普通账号可参与邀请');}};
  const adminOnly={preHandler:admin};
  let task=null;
  const timer=setInterval(()=>{if(!task)task=settleReferralPeriods(store,clock()).catch(()=>app.log.error('Referral settlement failed')).finally(()=>{task=null;});},60_000);
  timer.unref();
  app.addHook('onClose',async()=>{clearInterval(timer);await task;});

  app.get('/v1/referrals',userOnly,async req=>{
    const owner=req.auth.user_id,now=clock(),current=referralPeriod(now),start=datePeriod(req.query.date,current),offset=offsetValue(req.query.offset);
    await settleReferralPeriods(store,now,owner);
    return store.transaction(async()=>{
      const finalized=await store.get('SELECT registrations,paid FROM referral_periods WHERE owner_id=? AND period_start=?',owner,start);
      const counts=finalized?{registrations:Number(finalized.registrations),paid:Number(finalized.paid)}:await paidForPeriod(store,owner,start);
      const total=await store.get('SELECT COUNT(*) AS registrations FROM referral_attributions WHERE owner_id=?',owner);
      const people=await store.all(`SELECT a.registered_at,u.phone_number,COALESCE((SELECT SUM(e.units) FROM referral_earnings e
        WHERE e.owner_id=a.owner_id AND e.friend_id=a.friend_id AND ${activeEarned}),0) AS units FROM referral_attributions a
        JOIN users u ON u.id=a.friend_id WHERE a.owner_id=? AND a.period_start=? ORDER BY a.registered_at DESC,a.friend_id LIMIT 31 OFFSET ?`,owner,start,offset);
      const qr=await store.get("SELECT id FROM referral_cash_operations WHERE owner_id=? AND kind='withdrawal' LIMIT 1",owner);
      return {...await cashSummary(store,owner),...counts,today:dayDate(current),date:dayDate(start),hasQr:!!qr,
        totalRegistrations:Number(total.registrations),
        startsAt:start,endsAt:start+DAY,packageReady:!!distribution,items:people.slice(0,30).map(row=>({phone:mask(row.phone_number),registeredAt:Number(row.registered_at),units:money(row.units)})),
        nextOffset:people.length>30?offset+30:null};
    });
  });

  function inviteCode(owner){
    return store.transaction(async()=>{
      const existing=await store.get('SELECT code FROM referral_codes WHERE owner_id=?',owner);
      if(existing)return existing.code;
      const code=randomBytes(32).toString('base64url');
      await store.run('INSERT INTO referral_codes(owner_id,code) VALUES(?,?)',owner,code);
      return code;
    });
  }

  app.post('/v1/referrals/share-code',userOnly,async req=>{
    fields(req.body,[]);
    return {inviteCode:await inviteCode(req.auth.user_id)};
  });
  app.post('/v1/referrals/share',userOnly,async req=>{
    fields(req.body,[]);
    if(!distribution)throw new ApiError(503,'REFERRAL_PACKAGE_UNAVAILABLE','分享安装包暂未就绪');
    await distribution.prepare();
    return {path:`/v1/referrals/download/${await inviteCode(req.auth.user_id)}`};
  });
  app.get('/v1/referrals/download/:code',async(req,reply)=>{
    const code=req.params.code;
    if(!distribution||!referralCodePattern.test(code)||!await store.get(`SELECT c.owner_id FROM referral_codes c
      JOIN users u ON u.id=c.owner_id WHERE c.code=? AND u.disabled=0 AND u.role='user'`,code))throw missing();
    const apk=await distribution.package(code);
    return reply.header('Content-Disposition','attachment; filename="float-ai.apk"').header('Content-Length',apk.length)
      .header('X-APK-SHA256',apk.sha256).type('application/vnd.android.package-archive').send(apk.stream);
  });

  async function operation(req,kind){
    fields(req.body,kind==='withdrawal'?['units','image','consent']:['units']);
    const owner=req.auth.user_id,requestKey=req.headers['idempotency-key'];
    if(typeof requestKey!=='string'||!/^[A-Za-z0-9_-]{16,100}$/u.test(requestKey))throw bad('申请编号无效');
    const requested=req.body.units;
    if(!Number.isSafeInteger(requested)||requested<1||requested>MAX_OPERATION)throw bad('金额无效');
    const withdrawal=kind==='withdrawal';
    if(withdrawal&&requested<MIN_WITHDRAWAL)throw bad('最低提现金额为10元');
    if(withdrawal&&requested%4!==0)throw bad('提现金额须精确到分');
    if(withdrawal&&!vault.available)throw new ApiError(503,'WITHDRAWAL_UNAVAILABLE','提现暂不可用');
    const image=withdrawal&&req.body.image!==undefined?imageBytes(req.body.image):null;
    if(image&&req.body.consent!==true)throw bad('请确认授权处理本次上传的收款码');
    const requestHash=sha256(JSON.stringify([kind,requested,image?sha256(image):null]));
    const now=clock();
    await settleReferralPeriods(store,now,owner);
    return store.transaction(async()=>{
      const old=await store.get('SELECT * FROM referral_cash_operations WHERE owner_id=? AND request_key=?',owner,requestKey);
      if(old){if(old.request_hash!==requestHash)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','该申请编号已使用');return receipt(old);}
      if(await store.get('SELECT owner_id FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,abandonKey(requestKey)))
        throw new ApiError(409,'REFERRAL_REQUEST_ABANDONED','该申请已结束，请重新发起');
      if(requested>(await cashSummary(store,owner)).availableUnits)throw new ApiError(409,'REFERRAL_FUNDS_REQUIRED','可用收益不足，请刷新后重试');
      let cipher=null,createdAt=now;
      if(withdrawal){
        const prior=await store.get("SELECT qr_cipher,created_at FROM referral_cash_operations WHERE owner_id=? AND kind='withdrawal' ORDER BY created_at DESC,id DESC LIMIT 1",owner);
        if(prior)createdAt=Math.max(now,Number(prior.created_at)+1);
        cipher=image?vault.encode(image,owner):prior?.qr_cipher;
        if(!cipher)throw bad('请先上传收款码');
      }
      const op=id('rc'),status=withdrawal?'pending':'processed';
      await store.run(`INSERT INTO referral_cash_operations(id,owner_id,request_key,request_hash,kind,units,status,qr_cipher,created_at,processed_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,op,owner,requestKey,requestHash,kind,requested,status,cipher,createdAt,withdrawal?null:now);
      if(!withdrawal)await points(store,await store.get('SELECT * FROM users WHERE id=?',owner),pointValue(requested*5),null,'邀请收益兑换点数',`referral:${op}`);
      await store.audit(owner,`referral-${kind}`,op,{units:requested});
      return receipt({id:op,units:requested,status,created_at:createdAt,processed_at:withdrawal?null:now});
    });
  }
  app.get('/v1/referrals/operations/:key',userOnly,async req=>{
    if(!/^[A-Za-z0-9_-]{16,100}$/u.test(req.params.key))throw bad('申请编号无效');
    const row=await store.get('SELECT id,units,status,created_at,processed_at FROM referral_cash_operations WHERE owner_id=? AND request_key=?',req.auth.user_id,req.params.key);
    return {operation:row?receipt(row):null};
  });
  app.post('/v1/referrals/operations/:key/abandon',userOnly,async req=>{
    fields(req.body,[]);
    const key=req.params.key,owner=req.auth.user_id;
    if(!/^[A-Za-z0-9_-]{16,100}$/u.test(key))throw bad('申请编号无效');
    return store.transaction(async()=>{
      const row=await store.get('SELECT id,units,status,created_at,processed_at FROM referral_cash_operations WHERE owner_id=? AND request_key=?',owner,key);
      if(row)return {operation:receipt(row)};
      const closed=abandonKey(key);
      if(!await store.get('SELECT owner_id FROM confirmations WHERE owner_id=? AND idempotency_key=?',owner,closed))
        await store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',owner,closed,sha256(closed),'{}');
      return {operation:null};
    });
  });
  app.get('/v1/referrals/withdrawals',userOnly,async req=>{
    const before=req.query.before===undefined?null:Number(req.query.before);
    if(before!==null&&(!Number.isSafeInteger(before)||before<=0))throw bad('分页无效');
    const rows=await store.all(`SELECT id,units,status,created_at,processed_at FROM referral_cash_operations
      WHERE owner_id=? AND kind='withdrawal' ${before===null?'':'AND created_at<?'}
      ORDER BY created_at DESC,id DESC LIMIT 31`,req.auth.user_id,...(before===null?[]:[before]));
    return {items:rows.slice(0,30).map(receipt),nextBefore:rows.length>30?Number(rows[29].created_at):null};
  });
  app.post('/v1/referrals/withdrawals',userOnly,req=>operation(req,'withdrawal'));
  app.post('/v1/referrals/exchange',userOnly,req=>operation(req,'exchange'));
  app.get('/v1/admin/referral-withdrawals',adminOnly,async req=>{
    const offset=offsetValue(req.query.offset);
    const rows=await store.all(`SELECT r.id,r.units,r.status,r.created_at,r.processed_at,u.phone_number FROM referral_cash_operations r
      JOIN users u ON u.id=r.owner_id WHERE r.kind='withdrawal' ORDER BY r.created_at DESC,r.id LIMIT 31 OFFSET ?`,offset);
    return {items:rows.slice(0,30).map(row=>({...receipt(row),phone:row.phone_number})),nextOffset:rows.length>30?offset+30:null};
  });
  app.get('/v1/admin/referral-withdrawals/:id/qr',adminOnly,async req=>{
    const row=await store.get("SELECT owner_id,qr_cipher FROM referral_cash_operations WHERE id=? AND kind='withdrawal'",req.params.id);
    if(!row)throw missing();
    await store.audit(req.auth.user_id,'referral-withdrawal-qr-view',req.params.id);
    return {image:vault.decode(row.qr_cipher,row.owner_id)};
  });
  app.post('/v1/admin/referral-withdrawals/:id/process',adminOnly,async req=>{
    fields(req.body,[]);
    return store.transaction(async()=>{
      const row=await store.get("SELECT * FROM referral_cash_operations WHERE id=? AND kind='withdrawal'",req.params.id);
      if(!row)throw missing();
      if(row.status==='processed')return receipt(row);
      const now=Math.max(clock(),Number(row.created_at));
      await store.run("UPDATE referral_cash_operations SET status='processed',processed_at=?,processed_by=? WHERE id=?",now,req.auth.user_id,row.id);
      await store.audit(req.auth.user_id,'referral-withdrawal-processed',row.id);
      return receipt({...row,status:'processed',processed_at:now});
    });
  });
}
