import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {buildApp} from '../src/app.js';
import {ExternalPhoneService} from '../src/external-phone.js';
import {AsyncSqliteStore} from '../src/async-store.js';
import {call,password} from './helpers.js';

const phone='+8613800000041',second='+8613800000042';
const key=value=>createHash('sha256').update(value).digest('hex');
const verifier=(provider,options={})=>({provider,issuer:`synthetic:${provider}`,async send(){},
  async verify({phone}){return {issuer:this.issuer,subject:key(phone),phone};},...options});
const registration=(username,challengeId)=>({username,challengeId,verificationCode:'123456',password,passwordConfirmation:password,clientId:'android'});
const reset=(challengeId)=>({username:phone,challengeId,verificationCode:'123456',newPassword:'new-password',newPasswordConfirmation:'new-password'});
async function register(app,username=phone) {
  const code=await call(app,'POST','/v1/auth/registration-code',null,{username});assert.equal(code.statusCode,202,code.body);
  const result=await call(app,'POST','/v1/auth/register',null,registration(username,code.json().challengeId));assert.equal(result.statusCode,201,result.body);
  return result.json();
}
const appFor=(database,phoneVerifier)=>buildApp({database,rateLimits:false,smsLimits:false,phoneVerifier,allowVerifiedPhoneRecovery:true});

test('verified business phones survive Supabase to Aliyun and back; no user, balance or trial reset',async()=>{
  const root=resolve(fileURLToPath(new URL('../../artifacts/phone-provider-switch/',import.meta.url)));
  await mkdir(root,{recursive:true});const dir=await mkdtemp(join(root,'synthetic-'));const database=join(dir,'accounts.sqlite');let app;
  try {
    app=await appFor(database,verifier('supabase'));const session=await register(app);
    const before=await app.store.get('SELECT id,role,created_at,phone_number,phone_verified,trial_started,trial_ends FROM users WHERE username=?',phone);
    await app.close();app=null;
    const sends=[];app=await appFor(database,verifier('aliyun_pnvs',{async send(value){sends.push(value);}}));
    const code=await call(app,'POST','/v1/auth/password-reset-code',null,{username:phone});assert.equal(code.statusCode,202,code.body);
    assert.equal(sends[0].challengeId,code.json().challengeId);
    const done=await call(app,'POST','/v1/auth/reset-password',null,reset(code.json().challengeId));assert.equal(done.statusCode,204,done.body);
    assert.deepEqual(await app.store.get('SELECT id,role,created_at,phone_number,phone_verified,trial_started,trial_ends FROM users WHERE username=?',phone),before);
    assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger WHERE user_id=?',before.id)).n,1);
    assert.equal((await app.store.get('SELECT points_balance FROM users WHERE id=?',before.id)).points_balance,10);
    assert.equal((await app.store.get('SELECT COUNT(*) n FROM external_phone_identities WHERE user_id=?',before.id)).n,2);
    assert.equal((await call(app,'GET','/v1/me',session.accessToken)).statusCode,401);
    await register(app,second);await app.close();app=null;
    const supabaseSends=[];app=await appFor(database,verifier('supabase',{async send(value){supabaseSends.push(value);}}));
    const newUserCode=await call(app,'POST','/v1/auth/password-reset-code',null,{username:second});assert.equal(newUserCode.statusCode,202,newUserCode.body);
    assert.equal(supabaseSends[0].createUser,true);
    const recovered=await call(app,'POST','/v1/auth/reset-password',null,{...reset(newUserCode.json().challengeId),username:second});
    assert.equal(recovered.statusCode,204,recovered.body);
    assert.equal((await app.store.get('SELECT COUNT(*) n FROM users')).n,2);
    const login=await call(app,'POST','/v1/auth/login',null,{username:second,password:'new-password',clientId:'web'});assert.equal(login.statusCode,200,login.body);
  } finally {
    await app?.close();if(!resolve(dir).startsWith(root+sep))throw Error('Unsafe fixture cleanup');await rm(dir,{recursive:true,force:true});
  }
});

test('recovery enrollment is trusted-host opt-in; original generic verifier binding checks remain',async t=>{
  const old=await buildApp({rateLimits:false,smsLimits:false,phoneVerifier:verifier('supabase')});t.after(()=>old.close());
  await register(old);await old.store.run('DELETE FROM external_phone_identities');
  const code=await call(old,'POST','/v1/auth/password-reset-code',null,{username:phone});assert.equal(code.statusCode,422,code.body);
});
test('unverified or disabled business accounts cannot enroll a new recovery identity',async t=>{
  let sends=0;const app=await appFor(':memory:',verifier('aliyun_pnvs',{async send(){sends++;}}));t.after(()=>app.close());
  await register(app);await app.store.run('UPDATE users SET phone_verified=0 WHERE username=?',phone);
  assert.equal((await call(app,'POST','/v1/auth/password-reset-code',null,{username:phone})).statusCode,422);
  await app.store.run('UPDATE users SET phone_verified=1,disabled=1 WHERE username=?',phone);
  assert.equal((await call(app,'POST','/v1/auth/password-reset-code',null,{username:phone})).statusCode,403);
  assert.equal(sends,1);
});
test('new provider subject already bound to another business user cannot reset or overwrite that binding',async t=>{
  const app=await appFor(':memory:',verifier('supabase'));t.after(()=>app.close());
  await register(app);await register(app,second);
  const owner=await app.store.get('SELECT id,password_hash FROM users WHERE username=?',phone);
  const other=await app.store.get('SELECT id FROM users WHERE username=?',second);
  const vendor=verifier('aliyun_pnvs');await app.store.run('INSERT INTO external_phone_identities(issuer,subject,user_id,phone,verified_at) VALUES(?,?,?,?,?)',
    vendor.issuer,key(phone),other.id,phone,1);
  const service=new ExternalPhoneService(app.store,{verifier:vendor,limits:false,allowVerifiedPhoneRecovery:true});
  const code=await service.challenge(phone,'synthetic-ip',{purpose:'password_reset',user:{id:owner.id,phone_number:phone,phone_verified:1}});
  const proof=await service.prepare(code.challengeId,phone,'123456',{purpose:'password_reset',targetUserId:owner.id});
  await assert.rejects(()=>app.store.transaction(()=>service.consumePrepared(proof,owner.id)),e=>e.code==='RECOVERY_UNAVAILABLE');
  await service.release(proof);assert.equal((await app.store.get('SELECT password_hash FROM users WHERE id=?',owner.id)).password_hash,owner.password_hash);
  assert.equal((await app.store.get('SELECT user_id FROM external_phone_identities WHERE issuer=?',vendor.issuer)).user_id,other.id);
});
test('provider switch invalidates outstanding old challenges rather than verifying them with the other provider',async()=>{
  const store=await AsyncSqliteStore.open(':memory:');let verifies=0;
  try {
    const old=new ExternalPhoneService(store,{verifier:verifier('supabase',{async verify(){verifies++;}}),limits:false});await old.initialize();
    const code=await old.challenge(phone,'synthetic-ip');
    const next=new ExternalPhoneService(store,{verifier:verifier('aliyun_pnvs'),limits:false});await next.initialize();
    await assert.rejects(()=>old.prepare(code.challengeId,phone,'123456'),e=>e.code==='VALIDATION_FAILED');
    await assert.rejects(()=>next.prepare(code.challengeId,phone,'123456'),e=>e.code==='VALIDATION_FAILED');assert.equal(verifies,0);
  }finally{await store.close();}
});
