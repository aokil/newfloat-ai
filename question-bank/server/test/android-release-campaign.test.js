import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AndroidReleaseCampaign} from '../src/android-release-campaign.js';
import {points} from '../src/account.js';
import {testApp,register,password} from './helpers.js';

const newHeaders=token=>({authorization:`Bearer ${token}`,'x-float-app-version':'68'});
async function setup(t){
  const campaign=new AndroidReleaseCampaign({fetchRelease:async()=>new Response('',{status:404})});
  const app=await testApp({androidReleaseCampaign:campaign});t.after(()=>app.close());
  const session=await register(app,'campaign-account');
  const cutoff=Date.now()-1000;
  await app.store.run('UPDATE users SET created_at=? WHERE id=?',cutoff-1000,session.principal.userId);
  campaign.active={versionCode:68,releaseUrl:'https://github.com/aokil/newfloat-ai/releases/tag/android-v68',publishedAt:cutoff};
  return {app,campaign,session,cutoff};
}
test('policy activates only for the published final release and caches without polling',async()=>{
  let calls=0,now=100000;
  const release={draft:false,prerelease:false,tag_name:'android-v68',html_url:'https://github.com/aokil/newfloat-ai/releases/tag/android-v68',published_at:new Date(90000).toISOString(),body:'【强制更新】服务端负载优化',assets:[{name:'tiyu-update.json',state:'uploaded',size:100},{name:'tiyu-'+'a'.repeat(64)+'.apk',state:'uploaded',size:5000}]};
  const campaign=new AndroidReleaseCampaign({now:()=>now,fetchRelease:async()=>{calls++;return new Response(JSON.stringify(release));}});
  const [a,b]=await Promise.all([campaign.policy(),campaign.policy()]);assert.equal(a.publishedAt,90000);assert.equal(a,b);assert.equal(calls,1);
  now+=1000000;await campaign.policy();assert.equal(calls,1);
  release.draft=true;
  const invalid=new AndroidReleaseCampaign({now:()=>now,fetchRelease:async()=>new Response(JSON.stringify(release))});
  await assert.rejects(()=>invalid.policy(),e=>e.code==='UPDATE_POLICY_UNAVAILABLE');
});
test('old Android sessions and login/refresh are gated; current Android and web remain usable',async t=>{
  const {app,session}=await setup(t);
  const old=await app.inject({url:'/v1/me',headers:{authorization:`Bearer ${session.accessToken}`}});
  assert.equal(old.statusCode,426);assert.equal(old.json().error.code,'APP_UPDATE_REQUIRED');
  assert.equal((await app.inject({url:'/v1/me',headers:newHeaders(session.accessToken)})).statusCode,200);
  const loginBody={username:session.principal.phoneNumber,password,clientId:'android'};
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/login',payload:loginBody})).statusCode,426);
  assert.equal((await app.inject({method:'POST',url:'/v1/auth/refresh',payload:{refreshToken:session.refreshToken,clientId:'android'}})).statusCode,426);
  const web=await app.inject({method:'POST',url:'/v1/auth/login',payload:{...loginBody,clientId:'web'}});
  assert.equal(web.statusCode,200);
  const denied=await app.inject({method:'POST',url:'/v1/me/update-reward',headers:newHeaders(web.json().accessToken),payload:{}});
  assert.equal(denied.statusCode,426);
});
async function paymentFixture(app,userId,cutoff,{name,total,environment='production',status='paid',after=false,refund=false}){
  const id='pay_'+name.padEnd(32,'0'),at=cutoff+(after?100:-100);
  await app.store.transaction(async()=>{
    await app.store.run('INSERT INTO payment_orders(id,owner_id,idempotency_hash,request_hash,environment,app_id,seller_id,package_id,package_title,amount_minor,points,status,qr_code,trade_no,receipt_hash,error_code,created_at,updated_at,expires_at,precreate_at,checked_at,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,userId,name,name,environment,'synthetic-app','synthetic-seller','synthetic-package','synthetic',990,total,status,null,'trade-'+name,'synthetic-proof',refund?'PAYMENT_REFUND_REVIEW_REQUIRED':null,at,at,at+60000,at,at,status==='paid'?at:null);
    if(status==='paid'){
      await points(app.store,await app.store.get('SELECT * FROM users WHERE id=?',userId),total,null,'支付宝套餐购买','alipay:'+id);
      await app.store.run('UPDATE points_ledger SET created_at=? WHERE user_id=? AND idempotency_key=?',at,userId,'alipay:'+id);
    }
  });
}
test('reward is atomic once per account, counts only pre-release real credited points and floors 10%',async t=>{
  const {app,session,cutoff}=await setup(t),userId=session.principal.userId;
  await paymentFixture(app,userId,cutoff,{name:'a',total:111});
  await paymentFixture(app,userId,cutoff,{name:'b',total:300});
  await paymentFixture(app,userId,cutoff,{name:'c',total:600,environment:'sandbox'});
  await paymentFixture(app,userId,cutoff,{name:'d',total:100,after:true});
  await paymentFixture(app,userId,cutoff,{name:'e',total:100,status:'pending'});
  await paymentFixture(app,userId,cutoff,{name:'f',total:100,refund:true});
  const before=(await app.store.get('SELECT points_balance FROM users WHERE id=?',userId)).points_balance;
  const claim=()=>app.inject({method:'POST',url:'/v1/me/update-reward',headers:newHeaders(session.accessToken),payload:{}});
  const responses=await Promise.all([claim(),claim(),claim()]);responses.forEach(r=>assert.equal(r.statusCode,200,r.body));
  assert.deepEqual(responses.map(r=>r.json().updateReward.status).sort(),['already_claimed','already_claimed','granted']);
  assert.equal(responses[0].json().updateReward.paidPoints,411);assert.equal(responses[0].json().updateReward.paidBonus,41);
  assert.equal((await app.store.get('SELECT points_balance FROM users WHERE id=?',userId)).points_balance,before+91);
  const rows=await app.store.all("SELECT * FROM points_ledger WHERE user_id=? AND idempotency_key LIKE 'android-update:v68:%'",userId);
  assert.equal(rows.length,2);assert.equal(rows.reduce((s,r)=>s+r.delta,0),91);
  await claim();assert.equal((await app.store.get('SELECT points_balance FROM users WHERE id=?',userId)).points_balance,before+91);
});
test('post-release users receive nothing; failed claims roll back both ledger and receipt',async t=>{
  const {app,session,cutoff}=await setup(t),userId=session.principal.userId;
  await app.store.run('UPDATE users SET created_at=? WHERE id=?',cutoff+1,userId);
  const claim=()=>app.inject({method:'POST',url:'/v1/me/update-reward',headers:newHeaders(session.accessToken),payload:{}});
  const response=await claim();assert.equal(response.statusCode,200);assert.equal(response.json().updateReward.status,'not_eligible');
  assert.equal((await app.store.get('SELECT points_balance FROM users WHERE id=?',userId)).points_balance,10);
  await app.store.run('DELETE FROM confirmations WHERE owner_id=? AND idempotency_key=?',userId,'android-update:v68');
  await app.store.run('UPDATE users SET created_at=?,points_balance=? WHERE id=?',cutoff-1,1000000000,userId);
  assert.equal((await claim()).statusCode,422);
  assert.equal((await app.store.get("SELECT COUNT(*) AS n FROM points_ledger WHERE user_id=? AND idempotency_key LIKE 'android-update:v68:%'",userId)).n,0);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM confirmations WHERE owner_id=? AND idempotency_key=?',userId,'android-update:v68')).n,0);
});
