import {test} from 'node:test';
import assert from 'node:assert/strict';
import {testApp,register,password,call} from './helpers.js';

test('retired notification endpoint finishes with JSON 404 for anonymous and signed-in clients',{timeout:5000},async t=>{
  const app=await testApp();t.after(()=>app.close());
  const session=await register(app,'legacy-notification-client');
  for(const token of [null,session.accessToken]){
    const response=await call(app,'GET','/v1/auth/session-events',token);
    assert.equal(response.statusCode,404,response.body);
    assert.equal(response.json().error.code,'SESSION_EVENTS_DISABLED');
    assert.equal(response.json().error.retryable,false);
    assert(!response.headers['content-type'].startsWith('text/event-stream'));
  }
  assert.equal((await call(app,'GET','/v1/me',session.accessToken)).statusCode,200);
});

test('new login revokes old access and refresh on demand without a notification connection',async t=>{
  const app=await testApp();t.after(()=>app.close());
  const old=await register(app,'single-session-without-push');
  const login=await call(app,'POST','/v1/auth/login',null,{username:old.principal.phoneNumber,password,clientId:'web'});
  assert.equal(login.statusCode,200,login.body);const current=login.json();
  const rejected=await call(app,'GET','/v1/me',old.accessToken);
  assert.equal(rejected.statusCode,401);assert.equal(rejected.json().error.code,'SESSION_REVOKED');
  const refresh=await call(app,'POST','/v1/auth/refresh',null,{refreshToken:old.refreshToken,clientId:'android'});
  assert.equal(refresh.statusCode,401);assert.equal(refresh.json().error.code,'SESSION_REVOKED');
  assert.equal((await call(app,'GET','/v1/me',current.accessToken)).statusCode,200);
  const wrong=await call(app,'POST','/v1/auth/login',null,{username:old.principal.phoneNumber,password:'wrong-test-password',clientId:'android'});
  assert.equal(wrong.statusCode,401);
  assert.equal((await call(app,'GET','/v1/me',current.accessToken)).statusCode,200);
});
