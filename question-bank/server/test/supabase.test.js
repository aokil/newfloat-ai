import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {configuredSupabasePhone} from '../src/supabase-phone.js';
import {ExternalPhoneService} from '../src/external-phone.js';
import {SmsService} from '../src/sms.js';
import {Store} from '../src/store.js';
import {AsyncSqliteStore} from '../src/async-store.js';
import {ApiError} from '../src/security.js';
import {buildApp} from '../src/app.js';
import {call,password} from './helpers.js';

const env={SMS_PROVIDER:'supabase',SUPABASE_URL:'https://synthetic-phone.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic_fixture_key_not_real'};
const phone='+8613800000001',other='+8613800000002',subject='11111111-1111-4111-8111-111111111111';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json','x-supabase-api-version':'2024-01-01'}});
const proofVerifier=(options={})=>({provider:'supabase',issuer:env.SUPABASE_URL+'/auth/v1',async send(){},async verify({phone}){return {issuer:this.issuer,subject,phone};},...options});
const payload=(challengeId,username=phone)=>({username,challengeId,verificationCode:'123456',password,passwordConfirmation:password,clientId:'android'});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('Supabase config is optional, pinned HTTPS, public-key only and absent config fails closed',async t=>{
  for(const override of [{SUPABASE_URL:''},{SUPABASE_PUBLISHABLE_KEY:''},{SUPABASE_URL:'http://example.org'},
    {SUPABASE_URL:'https://example.org/auth/v1'},{SUPABASE_URL:'https://127.0.0.1'},
    {SUPABASE_URL:'https://u:p@example.org'},{SUPABASE_URL:'https://example.org?key=x'},
    {SUPABASE_PUBLISHABLE_KEY:'sb_secret_not_acceptable'},
    {SUPABASE_PUBLISHABLE_KEY:`e30.${Buffer.from('{"role":"service_role"}').toString('base64url')}.x`}])
    assert.equal(configuredSupabasePhone({...env,...override}),null);
  assert(configuredSupabasePhone({...env,SUPABASE_PUBLISHABLE_KEY:'',SUPABASE_ANON_KEY:`e30.${Buffer.from('{"role":"anon"}').toString('base64url')}.x`}));
  const app=await buildApp({rateLimits:false,phoneVerifier:configuredSupabasePhone({SMS_PROVIDER:'supabase'})});t.after(()=>app.close());
  assert.equal((await call(app,'POST','/v1/auth/registration-code',null,{username:phone})).json().error.code,'SMS_NOT_CONFIGURED');
  assert.equal((await call(app,'POST','/v1/auth/register',null,payload('missing'))).json().error.code,'SMS_NOT_CONFIGURED');
});

test('actual Supabase SDK uses OTP and trusted getUser; no password, role metadata or upstream token enters business session',async t=>{
  const calls=[];const user={id:subject,phone:phone.slice(1),phone_confirmed_at:new Date().toISOString(),is_anonymous:false,
    user_metadata:{role:'admin',points:9999},app_metadata:{role:'admin'}};
  const access='synthetic-upstream-access-token',refresh='synthetic-upstream-refresh-token';
  const verifier=configuredSupabasePhone(env,{fetch:async(url,init)=>{
    calls.push({url,init,body:init.body?JSON.parse(init.body):null});assert.equal(init.redirect,'error');assert(init.signal);
    if(url.endsWith('/otp'))return json({message_id:'synthetic-only'});
    if(url.endsWith('/verify'))return json({access_token:access,refresh_token:refresh,expires_in:3600,token_type:'bearer',user});
    if(url.endsWith('/user')){assert.equal(new Headers(init.headers).get('authorization'),`Bearer ${access}`);return json(user);}
    assert.fail('Unexpected network path');
  }});
  const app=await buildApp({rateLimits:false,smsLimits:false,phoneVerifier:verifier});t.after(()=>app.close());
  const c=await call(app,'POST','/v1/auth/registration-code',null,{username:phone});assert.equal(c.statusCode,202,c.body);
  const r=await call(app,'POST','/v1/auth/register',null,payload(c.json().challengeId));assert.equal(r.statusCode,201,r.body);
  const session=r.json();assert.deepEqual(session.principal.roles,['user']);assert.equal(session.account.pointsBalance,10);
  assert(!r.body.includes(access)&&!r.body.includes(refresh));assert.equal(session.principal.phoneVerified,true);
  assert.equal(calls.length,3);assert.equal(calls[0].body.create_user,true);assert.equal(calls[0].body.channel,'sms');
  assert(!JSON.stringify(calls).includes(password));assert.equal(calls[1].body.type,'sms');
  const binding=(await app.store.get('SELECT * FROM external_phone_identities'));assert.equal(binding.issuer,verifier.issuer);assert.equal(binding.subject,subject);
  assert.equal((await app.store.get('SELECT code_hmac FROM sms_challenges')).code_hmac,'');
  const login=await call(app,'POST','/v1/auth/login',null,{username:phone,password,clientId:'web'});assert.equal(login.statusCode,200,login.body);assert.equal(calls.length,3);
  const resetCode=await call(app,'POST','/v1/auth/password-reset-code',null,{username:phone});assert.equal(resetCode.statusCode,202,resetCode.body);
  assert.equal(calls[3].body.create_user,false);assert.equal(calls[3].body.channel,'sms');
  const reset=await call(app,'POST','/v1/auth/reset-password',null,{username:phone,challengeId:resetCode.json().challengeId,verificationCode:'123456',newPassword:'sixsix',newPasswordConfirmation:'sixsix'});
  assert.equal(reset.statusCode,204,reset.body);assert.equal(calls.length,6);assert.equal(calls[4].body.type,'sms');
  assert.equal((await call(app,'POST','/v1/auth/register',null,{...payload(c.json().challengeId),password:'another-strong-password',passwordConfirmation:'another-strong-password'})).statusCode,409);
  assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger')).n,1);
});

test('trusted Supabase phone formatting accepts E.164 with or without plus and rejects other countries',async()=>{
  for(const value of [phone,phone.slice(1),phone.slice(3),'+14155552671','14155552671',other]){
    const user={id:subject,phone:value,phone_confirmed_at:new Date().toISOString()};
    const verifier=configuredSupabasePhone(env,{fetch:async url=>json(url.endsWith('/verify')?
      {access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,user}:user)});
    if([phone,phone.slice(1),phone.slice(3)].includes(value))assert.equal((await verifier.verify({phone,code:'123456'})).phone,phone);
    else await assert.rejects(()=>verifier.verify({phone,code:'123456'}),e=>e.code==='SMS_UNAVAILABLE');
  }
});

test('SDK adapter rejects unconfirmed/mismatched identity, redirects, oversized replies, network failures and retries no SMS',async()=>{
  for(const scenario of ['unconfirmed','mismatch','subject','redirect','oversized','network','badcode','foreign']){
    let count=0;const user={id:subject,phone:phone.slice(1),phone_confirmed_at:new Date().toISOString()};
    const verifier=configuredSupabasePhone(env,{fetch:async(url)=>{
      count++;
      if(scenario==='redirect')return new Response(null,{status:302,headers:{location:'https://untrusted.example/steal'}});
      if(scenario==='oversized')return new Response('x'.repeat(65537));
      if(scenario==='network')throw new Error('synthetic secret must not escape');
      if(scenario==='badcode')return json({code:'otp_expired',msg:'bad code'},403);
      if(scenario==='foreign'){const r=json({});Object.defineProperty(r,'url',{value:'https://untrusted.example/auth/v1/verify'});return r;}
      if(url.endsWith('/verify'))return json({access_token:'synthetic-token',refresh_token:'synthetic-refresh',expires_in:3600,user});
      return json({...user,...(scenario==='unconfirmed'?{phone_confirmed_at:null}:scenario==='mismatch'?{phone:other.slice(1)}:{id:'different'})});
    }});
    await assert.rejects(()=>verifier.verify({phone,code:'123456'}),e=>e.code===(scenario==='badcode'?'VALIDATION_FAILED':'SMS_UNAVAILABLE')&&!e.message.includes('secret'));
    assert(count<=2,scenario);
  }
  let sends=0;const failed=configuredSupabasePhone(env,{fetch:async()=>{sends++;return json({message:'failure'},503);}});
  await assert.rejects(()=>failed.send({phone}),e=>e.code==='SMS_UNAVAILABLE');assert.equal(sends,1);
  let aborted=false;const timeout=configuredSupabasePhone(env,{timeoutMs:15,fetch:async(_url,{signal})=>new Promise((_,reject)=>{
    const timer=setTimeout(()=>reject(new Error('test guard')),1000);
    signal.addEventListener('abort',()=>{clearTimeout(timer);aborted=true;reject(signal.reason);},{once:true});
  })});
  await assert.rejects(()=>timeout.send({phone}),e=>e.code==='SMS_UNAVAILABLE');assert(aborted);
});

test('concurrent registration claims OTP once and returns one local account, trial and gift',async t=>{
  const entered=deferred(),release=deferred();let verifies=0,sends=0;
  const verifier=proofVerifier({async send(){sends++;},async verify({phone}){verifies++;entered.resolve();await release.promise;return {issuer:this.issuer,subject,phone};}});
  const app=await buildApp({rateLimits:false,smsLimits:false,phoneVerifier:verifier});t.after(()=>app.close());
  const c=(await call(app,'POST','/v1/auth/registration-code',null,{username:phone})).json();
  const first=call(app,'POST','/v1/auth/register',null,payload(c.challengeId));await entered.promise;
  assert.equal((await call(app,'POST','/v1/auth/register',null,payload(c.challengeId))).statusCode,429);
  assert.equal((await call(app,'POST','/v1/auth/registration-code',null,{username:phone})).statusCode,429);
  release.resolve();assert.equal((await first).statusCode,201);assert.equal(verifies,1);assert.equal(sends,1);
  assert.equal((await app.store.get('SELECT COUNT(*) n FROM users')).n,1);assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger')).n,1);
  const u=(await app.store.get('SELECT * FROM users'));assert.equal(u.trial_ends-u.trial_started,900000);
});

test('external challenge enforces expiry, latest challenge, failure and send budgets, issuer/provider boundaries, uncertain restart',async()=>{
  const store=await AsyncSqliteStore.open(':memory:');let now=1000000,sends=0,verifies=0;const verifier=proofVerifier({async send(){sends++;},async verify(){verifies++;throw new ApiError(422,'VALIDATION_FAILED','synthetic invalid');}});
  const sms=new ExternalPhoneService(store,{verifier,now:()=>now});
  try {
    const c=await sms.challenge(phone,'ip');await assert.rejects(()=>sms.challenge(phone,'ip'),e=>e.code==='RATE_LIMITED');
    now+=60001;const newer=await sms.challenge(phone,'ip');await assert.rejects(()=>sms.prepare(c.challengeId,phone,'123456'));
    for(let i=0;i<5;i++)await assert.rejects(()=>sms.prepare(newer.challengeId,phone,'123456'));
    now+=60001;const third=await sms.challenge(phone,'ip');await assert.rejects(()=>sms.prepare(third.challengeId,phone,'123456'));assert.equal(verifies,5);
    now+=1800001;const fourth=await sms.challenge(phone,'ip');
    const switched=new ExternalPhoneService(store,{verifier:proofVerifier({issuer:'https://different.supabase.co/auth/v1'}),now:()=>now});await switched.initialize();
    await assert.rejects(()=>switched.prepare(fourth.challengeId,phone,'123456'));assert.equal(verifies,5);
    const local=new SmsService(store,{transport:{},hmacKey:'synthetic-only-key-with-at-least32bytes',now:()=>now});await local.initialize();await assert.rejects(()=>local.verify(fourth.challengeId,phone,'123456'));
    const switchedBack=new ExternalPhoneService(store,{verifier,now:()=>now});await switchedBack.initialize();await assert.rejects(()=>switchedBack.prepare(fourth.challengeId,phone,'123456'));
    now+=300001;await assert.rejects(()=>sms.prepare(fourth.challengeId,phone,'123456'));
    now+=3600001;const fifth=await sms.challenge(phone,'ip');(await store.run("UPDATE sms_challenges SET state='verifying',attempt_nonce='synthetic' WHERE id=?",fifth.challengeId));
    now+=300001;const restarted=new ExternalPhoneService(store,{verifier,now:()=>now});await restarted.initialize();assert.equal((await store.get('SELECT state FROM sms_challenges WHERE id=?',fifth.challengeId)).state,'uncertain');
    await assert.rejects(()=>restarted.prepare(fifth.challengeId,phone,'123456'));assert.equal(verifies,5);
    const unavailable=new ExternalPhoneService(store,{verifier:proofVerifier({async send(){throw new Error('synthetic timeout');}}),now:()=>now});
    await assert.rejects(()=>unavailable.challenge(other,'ip'),e=>e.code==='SMS_UNAVAILABLE');assert.equal((await store.get('SELECT state FROM sms_challenges WHERE phone=?',other)).state,'uncertain');
    await assert.rejects(()=>unavailable.challenge(other,'ip'),e=>e.code==='RATE_LIMITED');
  }finally{(await store.close());}
});

test('late proof cannot commit after expiry and uncertain verification cannot be retried',async()=>{
  const store=await AsyncSqliteStore.open(':memory:');let now=1000000,verifies=0;
  const sms=new ExternalPhoneService(store,{verifier:proofVerifier(),limits:false,now:()=>now});
  try {
    const c=await sms.challenge(phone,'ip');const proof=await sms.prepare(c.challengeId,phone,'123456');now+=300001;
    await assert.rejects(()=>store.transaction(()=>sms.consumePrepared(proof,'never-created-user')),e=>e.code==='VALIDATION_FAILED');(await sms.release(proof));
    assert.equal((await store.get('SELECT COUNT(*) n FROM external_phone_identities')).n,0);
    const uncertain=new ExternalPhoneService(store,{verifier:proofVerifier({async verify(){verifies++;throw new Error('synthetic lost response');}}),limits:false,now:()=>now});
    const next=await uncertain.challenge(phone,'ip');
    await assert.rejects(()=>uncertain.prepare(next.challengeId,phone,'123456'),e=>e.code==='SMS_UNAVAILABLE');
    await assert.rejects(()=>uncertain.prepare(next.challengeId,phone,'123456'),e=>e.code==='VALIDATION_FAILED');assert.equal(verifies,1);
  }finally{(await store.close());}
});

test('verified OTP with failed local commit cannot be reused; external subject cannot bind another local account',async t=>{
  const app=await buildApp({rateLimits:false,smsLimits:false,phoneVerifier:proofVerifier()});t.after(()=>app.close());
  const getCode=async username=>(await call(app,'POST','/v1/auth/registration-code',null,{username})).json().challengeId;
  let id=await getCode(phone);
  (await app.store.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON points_ledger BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END;"));
  const failure=await call(app,'POST','/v1/auth/register',null,payload(id));assert.equal(failure.statusCode,503);assert(failure.json().error.message.includes('重新获取'));
  for(const table of ['users','points_ledger','external_phone_identities','sessions'])assert.equal((await app.store.get(`SELECT COUNT(*) n FROM ${table}`)).n,0);
  assert.equal((await app.store.get('SELECT state FROM sms_challenges WHERE id=?',id)).state,'uncertain');
  (await app.store.exec('DROP TRIGGER synthetic_failure'));assert.equal((await call(app,'POST','/v1/auth/register',null,payload(id))).statusCode,422);
  id=await getCode(phone);assert.equal((await call(app,'POST','/v1/auth/register',null,payload(id))).statusCode,201);
  const otherId=await getCode(other);assert.equal((await call(app,'POST','/v1/auth/register',null,payload(otherId,other))).statusCode,409);
  assert.equal((await app.store.get('SELECT COUNT(*) n FROM users')).n,1);assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger')).n,1);
});

test('schema 3 file upgrades to current schema and reopens preserving users; unsupported future schema is rejected with handle closed',async()=>{
  const artifactRoot=resolve(fileURLToPath(new URL('../../artifacts/m3/',import.meta.url)));
  await mkdir(artifactRoot,{recursive:true});
  const dir=await mkdtemp(join(artifactRoot,'migration-'));const db=join(dir,'synthetic.sqlite');
  let store;
  try {
    store=new Store(db);
    (await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number) VALUES(?,?,?,?,?,?,?)','synthetic-user',phone,'synthetic','unused-test-hash','user',1,phone));
    // Remove only schema 4 additions to reconstruct the schema 3 starting point, without touching frozen files.
    (await store.close());store=null;
    const {DatabaseSync}=await import('node:sqlite');const old=new DatabaseSync(db);
    old.exec('DROP TABLE user_feedback; DROP TABLE app_promotions; DROP TABLE payment_orders; DROP TABLE ai_requests; ALTER TABLE users DROP COLUMN avatar_id; ALTER TABLE banks DROP COLUMN deleted_at; ALTER TABLE banks DROP COLUMN description; DROP TABLE external_phone_identities; DROP INDEX sms_target_purpose; ALTER TABLE sms_challenges DROP COLUMN purpose; ALTER TABLE sms_challenges DROP COLUMN target_user_id; ALTER TABLE sms_challenges DROP COLUMN provider; ALTER TABLE sms_challenges DROP COLUMN issuer; ALTER TABLE sms_challenges DROP COLUMN attempt_nonce; PRAGMA user_version=3;');old.close();
    store=new Store(db);assert.equal((await store.get('PRAGMA user_version')).user_version,11);assert.equal((await store.get('SELECT phone_number FROM users')).phone_number,phone);
    assert.equal((await store.get('SELECT COUNT(*) n FROM external_phone_identities')).n,0);(await store.close());store=null;
    store=new Store(db);assert.equal((await store.get('SELECT COUNT(*) n FROM users')).n,1);store.db.exec('PRAGMA user_version=12;');(await store.close());store=null;
    assert.throws(()=>new Store(db),/newer/);
  }finally{(await store?.close());if(!resolve(dir).startsWith(artifactRoot+sep))throw new Error('Unsafe test cleanup');await rm(dir,{recursive:true,force:true});}
});

test('schema 4 production-shaped identity and challenge rows migrate to current schema without account changes',async()=>{
  const artifactRoot=resolve(fileURLToPath(new URL('../../artifacts/m3/',import.meta.url)));
  await mkdir(artifactRoot,{recursive:true});
  const dir=await mkdtemp(join(artifactRoot,'migration-schema4-'));const db=join(dir,'synthetic.sqlite');let store;
  try {
    store=new Store(db);
    (await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number,phone_verified,points_balance,trial_started,trial_ends) VALUES(?,?,?,?,?,?,?,?,?,?,?)','existing-user',phone,'existing','preserved-hash','admin',123,phone,1,10,123,900123));
    (await store.run('INSERT INTO external_phone_identities(issuer,subject,user_id,phone,verified_at) VALUES(?,?,?,?,?)',env.SUPABASE_URL+'/auth/v1',subject,'existing-user',phone,456));
    (await store.run('INSERT INTO sms_challenges(id,phone,code_hmac,expires_at,created_at,ip_hash,state,provider,issuer) VALUES(?,?,?,?,?,?,?,?,?)','existing-challenge',phone,'',999999,100,'ip-hash','sent','supabase',env.SUPABASE_URL+'/auth/v1'));
    (await store.close());store=null;
    const {DatabaseSync}=await import('node:sqlite');const old=new DatabaseSync(db);
    old.exec('DROP TABLE user_feedback; DROP TABLE app_promotions; DROP TABLE payment_orders; DROP TABLE ai_requests; ALTER TABLE users DROP COLUMN avatar_id; ALTER TABLE banks DROP COLUMN deleted_at; ALTER TABLE banks DROP COLUMN description; DROP INDEX sms_target_purpose; ALTER TABLE sms_challenges DROP COLUMN purpose; ALTER TABLE sms_challenges DROP COLUMN target_user_id; PRAGMA user_version=4;');old.close();
    store=new Store(db);assert.equal((await store.get('PRAGMA user_version')).user_version,11);
    const user=(await store.get('SELECT role,password_hash,points_balance,trial_started,trial_ends FROM users WHERE id=?','existing-user'));
    assert.equal(user.role,'admin');assert.equal(user.password_hash,'preserved-hash');assert.equal(user.points_balance,10);assert.equal(user.trial_started,123);assert.equal(user.trial_ends,900123);
    const binding=(await store.get('SELECT issuer,subject,user_id,phone FROM external_phone_identities WHERE user_id=?','existing-user'));assert.equal(binding.subject,subject);assert.equal(binding.phone,phone);
    const challenge=(await store.get('SELECT purpose,target_user_id,state,provider,issuer FROM sms_challenges WHERE id=?','existing-challenge'));
    assert.equal(challenge.purpose,'registration');assert.equal(challenge.target_user_id,null);assert.equal(challenge.state,'sent');assert.equal(challenge.provider,'supabase');
  }finally{(await store?.close());if(!resolve(dir).startsWith(artifactRoot+sep))throw new Error('Unsafe test cleanup');await rm(dir,{recursive:true,force:true});}
});
