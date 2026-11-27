import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildApp} from '../src/app.js';
import {Store} from '../src/store.js';
import {REFERRAL_TABLES} from '../src/referral-schema.js';
import {hashPassword,sha256} from '../src/security.js';
import {call,password} from './helpers.js';

const url='/v1/admin/phone-provider',phone='+8613800000061';
function verifier(provider,events,overrides={}) {
  return {provider,issuer:`synthetic:${provider}`,async send(data){events.push({provider,action:'send',...data});},
    async verify(data){events.push({provider,action:'verify',...data});if(data.code!=='123456')throw Error('invalid synthetic code');
      return {issuer:this.issuer,subject:sha256(data.phone),phone:data.phone};},...overrides};
}
async function fixture(t,{missing=null,overrides={}}={}) {
  const root=resolve(fileURLToPath(new URL('../../artifacts/admin-phone-provider/',import.meta.url)));
  await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'synthetic-')),database=join(dir,'accounts.sqlite'),apps=[],events=[];
  t.after(async()=>{for(const app of apps.reverse())await app.close();
    if(!dir.startsWith(root+sep))throw Error('Unsafe fixture cleanup');await rm(dir,{recursive:true,force:true});});
  const verifiers=Object.fromEntries(['supabase','aliyun_pnvs'].map(p=>[p,missing===p?null:verifier(p,events,overrides[p])]));
  async function open(environment='PROD',providers=verifiers,defaultPhoneProvider='supabase') {
    const app=await buildApp({database,rateLimits:false,smsLimits:false,phoneProviders:providers,phoneProviderEnvironment:environment,
      defaultPhoneProvider,allowVerifiedPhoneRecovery:true});apps.push(app);return app;
  }
  const app=await open(),now=Date.now();
  await app.store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number,phone_verified,trial_started,trial_ends) VALUES(?,?,?,?,?,?,?,?,?,?)',
    'synthetic-admin','+8613900000061','合成管理员',await hashPassword(password),'admin',now,'+8613900000061',0,now,now+900000);
  const login=await call(app,'POST','/v1/auth/login',null,{username:'13900000061',password,clientId:'web'});
  assert.equal(login.statusCode,200,login.body);const token=login.json().accessToken;
  const select=(provider,revision=0,key='switch-'+provider,target=app)=>call(target,'PUT',url,token,{provider,expectedRevision:revision},key);
  const status=async(target=app)=>(await call(target,'GET',url,token)).json();
  const code=async(username=phone,target=app)=>{const r=await call(target,'POST','/v1/auth/registration-code',null,{username});assert.equal(r.statusCode,202,r.body);return r.json().challengeId;};
  return {app,events,verifiers,open,token,select,status,code};
}
const registration=challengeId=>({username:phone,password,passwordConfirmation:password,verificationCode:'123456',challengeId,clientId:'web'});

test('only an active administrator can read or change phone provider; credentials cannot be submitted',async t=>{
  const f=await fixture(t);
  assert.equal((await call(f.app,'GET',url)).statusCode,401);
  assert.equal((await call(f.app,'PUT',url,null,{provider:'aliyun_pnvs',expectedRevision:0},'none')).statusCode,401);
  for(const body of [{provider:'unknown',expectedRevision:0},{provider:{toString:1},expectedRevision:0},{provider:1,expectedRevision:0},{provider:'aliyun_pnvs'},
    {provider:'aliyun_pnvs',expectedRevision:0,apiKey:'never-accepted'}])
    assert.equal((await call(f.app,'PUT',url,f.token,body,'invalid-'+JSON.stringify(body))).statusCode,400);
  assert.equal((await call(f.app,'PUT',url,f.token,{provider:'aliyun_pnvs',expectedRevision:0})).statusCode,400);
  await f.app.store.run("UPDATE users SET role='user' WHERE id='synthetic-admin'");
  assert.equal((await call(f.app,'GET',url,f.token)).statusCode,403);
  assert.equal((await f.select('aliyun_pnvs')).statusCode,403);
  assert.equal((await f.app.store.get('SELECT COUNT(*) n FROM phone_provider_settings')).n,0);
});

test('switch persists across instances/restarts and overrides only the initial environment default',async t=>{
  const f=await fixture(t);assert.equal((await f.status()).provider,'supabase');
  const switched=await f.select('aliyun_pnvs');assert.equal(switched.statusCode,200,switched.body);
  assert.equal(switched.json().revision,1);assert.equal(switched.json().ready,true);
  const next=await f.open();assert.equal((await f.status(next)).provider,'aliyun_pnvs');
  await f.code(phone,next);assert.equal(f.events.at(-1).provider,'aliyun_pnvs');
  assert.equal((await f.select('supabase',1,'back',next)).statusCode,200);
  assert.equal((await f.status()).provider,'supabase');
  assert.equal(f.events.filter(e=>e.action==='send').length,1);
  const audit=await f.app.store.all("SELECT details FROM audit WHERE action='switch-phone-provider'");
  assert.equal(audit.length,2);assert.equal(JSON.parse(audit[0].details).to,'aliyun_pnvs');
});

test('a previously sent code verifies with its original provider after switching',async t=>{
  const f=await fixture(t),id=await f.code();await f.select('aliyun_pnvs');
  const result=await call(f.app,'POST','/v1/auth/register',null,registration(id));assert.equal(result.statusCode,201,result.body);
  assert.deepEqual(f.events.map(e=>[e.action,e.provider]),[['send','supabase'],['verify','supabase']]);
  const binding=await f.app.store.get('SELECT issuer FROM external_phone_identities');assert.equal(binding.issuer,'synthetic:supabase');
  assert.equal((await call(f.app,'POST','/v1/auth/register',null,registration(id))).statusCode,409);
});

test('an in-flight send stays on its captured provider; new requests use the new provider without double sends',async t=>{
  let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r);
  const f=await fixture(t,{overrides:{supabase:{async send(){started();await gate;}}}});
  const pending=call(f.app,'POST','/v1/auth/registration-code',null,{username:phone});await entered;
  assert.equal((await f.select('aliyun_pnvs')).statusCode,200);release();
  const old=await pending;assert.equal(old.statusCode,202,old.body);
  assert.equal((await f.app.store.get('SELECT provider FROM sms_challenges WHERE id=?',old.json().challengeId)).provider,'supabase');
  await f.code('+8613800000062');assert.equal(f.events.filter(e=>e.action==='send').length,1);
  assert.equal(f.events.at(-1).provider,'aliyun_pnvs');
});

test('concurrent admin views use revision checks and a lost response can replay the same operation',async t=>{
  const f=await fixture(t),other=await f.open();const before=await f.status(other);assert.equal(before.revision,0);
  const first=await f.select('aliyun_pnvs',0,'same-key');assert.equal(first.statusCode,200);
  const replay=await f.select('aliyun_pnvs',0,'same-key',other);assert.equal(replay.statusCode,200);assert.deepEqual(replay.json(),first.json());
  assert.equal((await f.select('supabase',0,'stale',other)).statusCode,409);
  assert.equal((await f.select('supabase',1,'same-key')).statusCode,409);
  assert.equal((await f.status()).revision,1);assert.equal(f.events.length,0);
});

test('missing credentials disable selection and do not silently send with the other provider',async t=>{
  const f=await fixture(t,{missing:'aliyun_pnvs'}),state=await f.status();
  assert.equal(state.providers.find(p=>p.provider==='aliyun_pnvs').configured,false);
  assert.equal((await f.select('aliyun_pnvs')).statusCode,422);assert.equal((await f.status()).provider,'supabase');
  const broken=await f.open('PROD',{supabase:null,aliyun_pnvs:verifier('aliyun_pnvs',f.events)},'supabase');
  assert.equal((await f.status(broken)).ready,false);
  assert.equal((await call(broken,'POST','/v1/auth/registration-code',null,{username:phone})).statusCode,503);
  assert.equal(f.events.length,0);
});

test('DEV and PROD selections remain independent in the same database',async t=>{
  const f=await fixture(t),dev=await f.open('DEV');await f.select('aliyun_pnvs',0,'prod');
  assert.equal((await f.status(dev)).provider,'supabase');
  assert.equal((await f.select('aliyun_pnvs',0,'dev',dev)).statusCode,200);
  assert.equal((await f.select('supabase',1,'prod-back')).statusCode,200);
  assert.equal((await f.status(dev)).provider,'aliyun_pnvs');
});

test('verified existing accounts can recover after a live provider switch',async t=>{
  const f=await fixture(t),id=await f.code();const registered=await call(f.app,'POST','/v1/auth/register',null,registration(id));
  assert.equal(registered.statusCode,201,registered.body);const before=registered.json();await f.select('aliyun_pnvs');
  const code=await call(f.app,'POST','/v1/auth/password-reset-code',null,{username:phone});assert.equal(code.statusCode,202,code.body);
  const reset=await call(f.app,'POST','/v1/auth/reset-password',null,{username:phone,challengeId:code.json().challengeId,verificationCode:'123456',
    newPassword:'changed-synthetic-password',newPasswordConfirmation:'changed-synthetic-password'});assert.equal(reset.statusCode,204,reset.body);
  assert.equal((await f.app.store.get('SELECT COUNT(*) n FROM external_phone_identities WHERE user_id=?',before.principal.userId)).n,2);
  assert.equal((await f.app.store.get('SELECT points_balance FROM users WHERE id=?',before.principal.userId)).points_balance,10);
  assert.equal(f.events.at(-1).provider,'aliyun_pnvs');
});

test('restart with removed old credentials refuses an old code rather than verifying it on the new provider',async t=>{
  const f=await fixture(t),id=await f.code();await f.select('aliyun_pnvs');
  const next=await f.open('PROD',{...f.verifiers,supabase:null});
  const result=await call(next,'POST','/v1/auth/register',null,registration(id));assert.equal(result.statusCode,503,result.body);
  assert.equal(f.events.filter(e=>e.action==='verify').length,0);
  assert.equal((await f.status(next)).provider,'aliyun_pnvs');
});

test('SQLite version11 upgrades without changing accounts; provider choice contains no credentials',async t=>{
  const f=await fixture(t);await f.select('aliyun_pnvs');
  const state=await f.status();assert.deepEqual(Object.keys(state).sort(),['provider','providers','ready','revision','updatedAt']);
  assert(!JSON.stringify(state).includes('synthetic:'));
  const db=join(resolve(fileURLToPath(new URL('../../artifacts/admin-phone-provider/',import.meta.url))),'migration-'+Date.now()+'.sqlite');
  let store=new Store(db);
  try{
    store.run("INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES('old','old','old','hash','user',1)");
    store.db.exec(`${REFERRAL_TABLES.map(name=>`DROP TABLE ${name};`).join('\n')}
      DROP TABLE phone_provider_settings;
      DROP TABLE external_phone_identities;
      CREATE TABLE external_phone_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        phone TEXT NOT NULL,verified_at INTEGER NOT NULL,PRIMARY KEY(issuer,subject));
      INSERT INTO external_phone_identities VALUES('old-supabase','old-subject','old','+8613800000099',123);
      PRAGMA user_version=11;`);
    store.close();store=null;
    store=new Store(db);assert.equal(store.get('PRAGMA user_version').user_version,13);
    assert.equal(store.get("SELECT password_hash FROM users WHERE id='old'").password_hash,'hash');
    assert.equal(store.get('SELECT COUNT(*) n FROM phone_provider_settings').n,0);
    assert.equal(store.get("SELECT verified_at FROM external_phone_identities WHERE issuer='old-supabase'").verified_at,123);
    store.run("INSERT INTO external_phone_identities VALUES('new-pnvs','new-subject','old','+8613800000099',124)");
    assert.throws(()=>store.run("INSERT INTO external_phone_identities VALUES('new-pnvs','another-subject','old','+8613800000099',125)"));
    assert.throws(()=>store.run("INSERT INTO phone_provider_settings VALUES('PROD','unknown',1,1,'old')"));
  }finally{store?.close();await rm(db,{force:true});await rm(db+'-wal',{force:true});await rm(db+'-shm',{force:true});}
});
