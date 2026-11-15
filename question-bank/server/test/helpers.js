import assert from 'node:assert/strict';
import {buildApp} from '../src/app.js';
export const password='test-only-strong-password';
export const auth=token=>({authorization:`Bearer ${token}`});
export async function call(app,method,url,token,body,key){return app.inject({method,url,headers:{...(token?auth(token):{}),...(key?{'idempotency-key':key}:{})},...(body!==undefined?{payload:body}:{})});}
export async function testApp(options={}){
  const codes=new Map();const app=await buildApp({rateLimits:false,smsLimits:false,smsHmacKey:'test-only-hmac-key-not-for-production-32bytes',smsTransport:{async send({phone,code}){codes.set(phone,code);}},...options});
  app.testCodes=codes;app.testPhones=new Map();return app;
}
export async function register(app,label){
  const username=`139${String(app.testPhones.size+1).padStart(8,'0')}`;app.testPhones.set(label,username);
  const challenge=await call(app,'POST','/v1/auth/registration-code',null,{username});assert.equal(challenge.statusCode,202,challenge.body);
  const response=await call(app,'POST','/v1/auth/register',null,{username,password,passwordConfirmation:password,verificationCode:app.testCodes.get(`+86${username}`),challengeId:challenge.json().challengeId,clientId:'android'});
  assert.equal(response.statusCode,201,response.body);return response.json();
}
