import assert from 'node:assert/strict';
import test from 'node:test';
import {Readable} from 'node:stream';
import {buildApp} from '../src/app.js';
import {issueSession,sha256} from '../src/security.js';
import {bindReferral,creditReferralOrder,referralPeriod,settleReferralPeriods} from '../src/referrals.js';
import {referralSlot,referralVariant} from '../src/referral-apk.js';

const start=Date.parse('2026-11-24T23:00:00+08:00'),day=86_400_000;
const photo='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';

async function fixture(t,hasDistribution=true){
  let now=start;
  const app=await buildApp({rateLimits:false,referralClock:()=>now,referralSecret:'synthetic-key-for-referral-vault-32',
    referralDistribution:hasDistribution?{prepare:async()=>{},package:async code=>({length:code.length,sha256:sha256(code),stream:Readable.from([code])})}:null});
  t.after(()=>app.close());
  async function user(id,index,role='user'){
    const phone=`+86137000${String(index).padStart(5,'0')}`;
    return app.store.transaction(async()=>{
      await app.store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number,phone_verified) VALUES(?,?,?,?,?,?,?,1)',id,phone,id,'test',role,start,phone);
      return (await issueSession(app.store,await app.store.get('SELECT * FROM users WHERE id=?',id),'android')).accessToken;
    });
  }
  const owner=await user('inviter',1),admin=await user('operator',2,'admin');
  const call=(method,url,token,payload,key)=>app.inject({method,url,payload,headers:{...(token?{authorization:`Bearer ${token}`} : {}),...(key?{'idempotency-key':key}:{})}});
  const shared=await call('POST','/v1/referrals/share-code',owner,{});
  assert.equal(shared.statusCode,200,shared.body);
  const code=shared.json().inviteCode,path=`/v1/referrals/download/${code}`;
  assert.match(code,/^[A-Za-z0-9_-]{43}$/u);
  async function friend(index){
    const name=`friend-${index}`;
    await user(name,index+10);
    await app.store.transaction(()=>bindReferral(app.store,name,code,now));
    return name;
  }
  async function paid(friend,id,minor=990,environment='production'){
    const order={id,owner_id:friend,environment,amount_minor:minor};
    await app.store.transaction(async()=>{
      await app.store.run(`INSERT INTO payment_orders(id,owner_id,idempotency_hash,request_hash,package_id,package_title,amount_minor,points,
        app_id,seller_id,environment,status,created_at,updated_at,expires_at,precreate_at,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'paid',?,?,?,?,?)`,
        id,friend,id,id,'points-100','test',minor,100,'app','seller',environment,now,now,now+1,now,now);
      await creditReferralOrder(app.store,order,now);
    });
  }
  return {app,call,owner,admin,code,path,friend,paid,user,advance:value=>{now=value;}};
}

test('23:00 is the new period and exact ten percent pays each direct registration once',async t=>{
  assert.equal(referralPeriod(start-1),start-day);assert.equal(referralPeriod(start),start);
  const f=await fixture(t);
  const friends=[];for(let i=0;i<10;i++)friends.push(await f.friend(i));
  await f.paid(friends[0],'one',990);await f.paid(friends[0],'repeat',1);await f.paid(friends[1],'sandbox',990,'sandbox');
  const current=(await f.call('GET','/v1/referrals',f.owner)).json();
  assert.equal(current.registrations,10);assert.equal(current.totalRegistrations,10);
  assert.equal(current.paid,1);assert.equal(current.availableUnits,991);
  assert.match(current.items[0].phone,/^137\*\*\*\*\d{4}$/u);
  f.advance(start+day);await settleReferralPeriods(f.app.store,start+day);await settleReferralPeriods(f.app.store,start+day);
  await f.friend(10);
  const result=(await f.call('GET','/v1/referrals?date=2026-11-25',f.owner)).json();
  assert.equal(result.availableUnits,2991);assert.equal(result.items.length,10);assert.equal(result.paid,1);
  const next=(await f.call('GET','/v1/referrals',f.owner)).json();
  assert.equal(result.registrations,10);assert.equal(next.registrations,1);
  assert.equal(result.totalRegistrations,11);assert.equal(next.totalRegistrations,11);
  assert.equal(next.totalUnits,result.totalUnits);
});

test('cash exchange, withdrawal, role checks and request snapshots are independent and idempotent',async t=>{
  const f=await fixture(t),friend=await f.friend(1);
  await f.paid(friend,'a',9001);
  const op='idempotency-withdrawal-1';
  const request={units:4000,image:photo,consent:true};
  const first=await f.call('POST','/v1/referrals/withdrawals',f.owner,request,op);
  assert.equal(first.statusCode,200,first.body);
  assert.deepEqual((await f.call('POST','/v1/referrals/withdrawals',f.owner,request,op)).json(),first.json());
  const second=await f.call('POST','/v1/referrals/withdrawals',f.owner,{units:4000},'idempotency-withdrawal-2');
  assert.equal(second.statusCode,200,second.body);
  const abandoned='idempotency-abandoned-exchange';
  assert.equal((await f.call('POST',`/v1/referrals/operations/${abandoned}/abandon`,f.owner,{})).statusCode,200);
  assert.equal((await f.call('POST','/v1/referrals/exchange',f.owner,{units:1001},abandoned)).statusCode,409);
  const exchange=await f.call('POST','/v1/referrals/exchange',f.owner,{units:1001},'idempotency-exchange-1');
  assert.equal(exchange.statusCode,200,exchange.body);
  assert.equal((await f.app.store.get('SELECT points_balance FROM users WHERE id=?','inviter')).points_balance,50.05);
  assert.equal((await f.call('POST','/v1/referrals/exchange',f.owner,{units:1},'idempotency-exchange-2')).statusCode,409);
  const path=`/v1/admin/referral-withdrawals/${first.json().id}`;
  assert.equal((await f.call('GET',`${path}/qr`,f.owner)).statusCode,403);
  assert.equal((await f.call('GET',`${path}/qr`,f.admin)).json().image,photo);
  for(let n=0;n<2;n++)assert.equal((await f.call('POST',`${path}/process`,f.admin,{})).json().status,'processed');
  const adminList=(await f.call('GET','/v1/admin/referral-withdrawals',f.admin)).json().items;
  assert.equal(adminList.length,2);assert.equal(adminList.find(item=>item.id===first.json().id).status,'processed');

  const historyPath='/v1/referrals/withdrawals';
  assert.equal((await f.call('GET',historyPath)).statusCode,401);
  assert.equal((await f.call('GET',historyPath,f.admin)).statusCode,403);
  const other=await f.user('other-inviter',99);
  assert.deepEqual((await f.call('GET',historyPath,other)).json(),{items:[],nextBefore:null});

  const history=await f.call('GET',historyPath,f.owner);
  assert.equal(history.statusCode,200,history.body);
  const processed=history.json().items[1];
  assert.ok(processed.processedAt>=processed.createdAt);
  assert.deepEqual(processed,{...first.json(),status:'processed',processedAt:processed.processedAt});
  assert.deepEqual(history.json(),{items:[second.json(),processed],nextBefore:null});
  assert.deepEqual((await f.call('GET',`${historyPath}?before=${second.json().createdAt}`,f.owner)).json(),
    {items:[processed],nextBefore:null});
  assert.equal((await f.call('GET',`${historyPath}?before=-1`,f.owner)).statusCode,400);
});

test('one share link per owner returns an APK attachment and its independently computed digest',async t=>{
  const f=await fixture(t);
  assert.equal((await f.call('POST','/v1/referrals/share',f.owner,{})).json().path,f.path);
  assert.equal((await f.call('POST','/v1/referrals/share',f.admin,{})).statusCode,403);
  const response=await f.call('GET',f.path);
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.headers['x-apk-sha256'],sha256(response.rawPayload));
});

test('local APK sharing has a stable owner code without a distribution APK',async t=>{
  const f=await fixture(t,false);
  const first=await f.call('POST','/v1/referrals/share-code',f.owner,{});
  assert.deepEqual(first.json(),{inviteCode:f.code});
  assert.equal((await f.call('POST','/v1/referrals/share-code')).statusCode,401);
  assert.equal((await f.call('POST','/v1/referrals/share-code',f.admin,{})).statusCode,403);
  assert.equal((await f.call('POST','/v1/referrals/share',f.owner,{})).statusCode,503);
  const friend=await f.friend(20);
  assert.equal((await f.app.store.get('SELECT owner_id FROM referral_attributions WHERE friend_id=?',friend)).owner_id,'inviter');
});

test('APK personalization consumes only the reserved slot in a synthetic signing block',async()=>{
  const signature=Buffer.alloc(13);signature.writeBigUInt64LE(5n);signature.writeUInt32LE(0x7109871a,8);
  const padding=Buffer.alloc(128);padding.writeBigUInt64LE(120n);padding.writeUInt32LE(0x42726577,8);
  const size=BigInt(signature.length+padding.length+24),entry=Buffer.alloc(8),footer=Buffer.alloc(24),eocd=Buffer.alloc(22);
  entry.writeBigUInt64LE(size);footer.writeBigUInt64LE(size);footer.write('APK Sig Block 42',8);
  const before=Buffer.concat([Buffer.from('preserved ZIP bytes'),entry,signature,padding,footer]);
  eocd.writeUInt32LE(0x06054b50);eocd.writeUInt32LE(before.length,16);
  const base=Buffer.concat([before,eocd]),slot=referralSlot(base),code='x'.repeat(43);
  const result=referralVariant(base,slot,code),chunks=[];for await(const part of result.stream)chunks.push(part);
  const output=Buffer.concat(chunks);
  assert.equal(base.length,output.length);assert.equal(result.sha256,sha256(output));
  assert(output.subarray(0,slot.offset).equals(base.subarray(0,slot.offset)));
  assert(output.subarray(slot.end).equals(base.subarray(slot.end)));
  assert.equal(output.toString('ascii',slot.offset+12,slot.offset+55),code);
});
