import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
import {hashPassword,verifyPassword} from '../src/security.js';
import {call,password} from './helpers.js';

const input={phoneNumber:'13800007777',password,passwordConfirmation:password,displayName:'代建用户',reason:'合成验收：用户无法收码'};
async function fixture(t){
  // No SMS transport/verifier is configured, including for the administrator.
  const app=await buildApp({rateLimits:false});t.after(()=>app.close());
  const now=Date.now();
  await app.store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number,phone_verified,trial_started,trial_ends) VALUES(?,?,?,?,?,?,?,?,?,?)','admin-fixture','+8613900007777','合成管理员',await hashPassword(password),'admin',now,'+8613900007777',0,now,now+900000);
  const login=await call(app,'POST','/v1/auth/login',null,{username:'13900007777',password,clientId:'web'});
  assert.equal(login.statusCode,200,login.body);
  return {app,token:login.json().accessToken};
}

test('admin creates a normal account without any SMS; web and Android login work without verification',async t=>{
  const {app,token}=await fixture(t);
  const response=await call(app,'POST','/v1/admin/users',token,input,'create');
  assert.equal(response.statusCode,200,response.body);
  const user=response.json(),stored=await app.store.get('SELECT * FROM users WHERE id=?',user.userId);
  assert.equal(user.phoneNumber,'+8613800007777');assert.equal(user.phoneVerified,false);
  assert.equal(user.pointsBalance,10);assert.equal(user.lastLoginAt,null);assert.equal(user.disabled,false);
  assert.equal(stored.role,'user');assert.equal(stored.membership,'free');assert.equal(stored.phone_verified,0);
  assert(await verifyPassword(password,stored.password_hash));assert.notEqual(stored.password_hash,password);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?',user.userId)).n,0);
  for(const clientId of ['web','android']){
    const login=await call(app,'POST','/v1/auth/login',null,{username:input.phoneNumber,password,clientId});
    assert.equal(login.statusCode,200,login.body);assert.deepEqual(login.json().principal.roles,['user']);
    assert.equal(login.json().account.entitlements.floatingAllowed,true);
    const me=await call(app,'GET','/v1/me',login.json().accessToken);assert.equal(me.statusCode,200);
    assert.equal(me.json().account.entitlements.importAllowed,true);
    assert.equal((await call(app,'GET','/v1/banks',login.json().accessToken)).statusCode,200);
  }
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM sms_challenges')).n,0);
  assert(!response.body.includes(password));assert(!response.body.includes('password_hash'));assert(!response.body.includes('accessToken'));
  const audit=await app.store.get("SELECT * FROM audit WHERE action='admin-create-user' AND target_id=?",user.userId);
  assert.equal(audit.actor_id,'admin-fixture');assert.equal(JSON.parse(audit.details).reason,input.reason);
});

test('admin create requires an active administrator and rejects privilege fields and invalid input',async t=>{
  const {app,token}=await fixture(t);
  assert.equal((await call(app,'POST','/v1/admin/users',null,input,'no-auth')).statusCode,401);
  const invalid=[{password:'12345',passwordConfirmation:'12345'},{passwordConfirmation:'different'},
    {phoneNumber:'123'},{reason:''},{displayName:' '},{role:'admin'},{phoneVerified:true},{pointsBalance:100}];
  for(const [i,changes] of invalid.entries())assert.equal((await call(app,'POST','/v1/admin/users',token,{...input,...changes},'invalid-'+i)).statusCode,400);
  assert.equal((await call(app,'POST','/v1/admin/users',token,input)).statusCode,400);
  await app.store.run("UPDATE users SET role='user' WHERE id='admin-fixture'");
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'ordinary')).statusCode,403);
  await app.store.run("UPDATE sessions SET revoked=1 WHERE user_id='admin-fixture'");
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'revoked')).statusCode,401);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM users')).n,1);
});

test('create retries grant exactly once and never store passwords or fast password fingerprints',async t=>{
  const {app,token}=await fixture(t);
  const first=await call(app,'POST','/v1/admin/users',token,input,'retry');assert.equal(first.statusCode,200,first.body);
  const repeat=await call(app,'POST','/v1/admin/users',token,{...input,phoneNumber:'+86'+input.phoneNumber},'retry');
  assert.equal(repeat.statusCode,200,repeat.body);assert.deepEqual(repeat.json(),first.json());
  assert.equal((await call(app,'POST','/v1/admin/users',token,{...input,displayName:'改变内容'},'retry')).statusCode,409);
  assert.equal((await call(app,'POST','/v1/admin/users',token,{...input,password:'another-password',passwordConfirmation:'another-password'},'retry')).statusCode,409);
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'duplicate')).statusCode,409);
  const userId=first.json().userId;
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM points_ledger WHERE user_id=?',userId)).n,1);
  assert.equal((await app.store.get("SELECT COUNT(*) AS n FROM audit WHERE action='admin-create-user' AND target_id=?",userId)).n,1);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM confirmations')).n,1);
  const receipt=await app.store.get('SELECT * FROM confirmations');assert(!JSON.stringify(receipt).includes(password));
  await app.store.run('UPDATE users SET password_hash=? WHERE id=?',await hashPassword('user-changed-password'),userId);
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'retry')).statusCode,409);
  assert(await verifyPassword('user-changed-password',(await app.store.get('SELECT password_hash FROM users WHERE id=?',userId)).password_hash));
});

test('concurrent account creates cannot overwrite an existing password or double grant points',async t=>{
  const {app,token}=await fixture(t);
  const alternate={...input,password:'second-password',passwordConfirmation:'second-password'};
  const responses=await Promise.all([call(app,'POST','/v1/admin/users',token,input,'same-key'),call(app,'POST','/v1/admin/users',token,alternate,'same-key')]);
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,409]);
  const user=await app.store.get('SELECT * FROM users WHERE phone_number=?','+86'+input.phoneNumber);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM points_ledger WHERE user_id=?',user.id)).n,1);
  assert(await verifyPassword(responses[0].statusCode===200?password:alternate.password,user.password_hash));
});

test('audit failure rolls back the account, gift and idempotency receipt together',async t=>{
  const {app,token}=await fixture(t),audit=app.store.audit.bind(app.store);
  app.store.audit=async(...args)=>{if(args[1]==='admin-create-user')throw Error('synthetic audit failure');return await audit(...args);};
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'rollback')).statusCode,500);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM users WHERE phone_number=?','+86'+input.phoneNumber)).n,0);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM points_ledger')).n,0);
  assert.equal((await app.store.get('SELECT COUNT(*) AS n FROM confirmations')).n,0);
  app.store.audit=audit;
  assert.equal((await call(app,'POST','/v1/admin/users',token,input,'rollback')).statusCode,200);
});
