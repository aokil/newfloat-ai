import {test} from 'node:test';
import assert from 'node:assert/strict';
import {configuredAliyunPnvsPhone} from '../src/aliyun-pnvs.js';
import {cozePhoneProvider,cozePhoneEnvironment,COZE_PHONE_BINDING_NAMES} from '../src/coze-phone-config.js';
import {configuredCozePhones} from '../src/coze-runtime.js';

const env={SMS_PROVIDER:'aliyun_pnvs',ALIYUN_ACCESS_KEY_ID:'synthetic-key',ALIYUN_ACCESS_KEY_SECRET:'synthetic-secret',
  ALIYUN_PNVS_SIGN_NAME:'合成测试签名',ALIYUN_PNVS_TEMPLATE_CODE:'100001',ALIYUN_PNVS_SCHEME_NAME:'synthetic-prod'};
const phone='+8613800000001',challengeId='sms_synthetic-request';
const ok=(Model)=>({body:{Code:'OK',Success:true,Model}});
function make(handler,configuration=env) {
  const calls=[];
  const verifier=configuredAliyunPnvsPhone(configuration,{clientFactory:config=>({async callApi(params,request,runtime){
    calls.push({config,params,request,runtime});return handler?.(params,request,runtime)??ok({OutId:request.query.OutId,VerifyResult:'PASS'});
  }})});
  return {verifier,calls};
}
test('installed official SDK client constructs without any SMS or verification request',()=>{
  const verifier=configuredAliyunPnvsPhone(env);
  assert.equal(verifier.provider,'aliyun_pnvs');assert.equal(typeof verifier.send,'function');assert.equal(typeof verifier.verify,'function');
});
test('PNVS config requires the selected product, signature/template and credentials; no guessing endpoints',()=>{
  for(const overrides of [{SMS_PROVIDER:'aliyun'},{ALIYUN_ACCESS_KEY_ID:''},{ALIYUN_ACCESS_KEY_SECRET:''},
    {ALIYUN_PNVS_SIGN_NAME:''},{ALIYUN_PNVS_TEMPLATE_CODE:''},{ALIYUN_PNVS_SCHEME_NAME:'x'.repeat(21)},
    {ALIYUN_SECURITY_TOKEN:'bad\ntoken'}])assert.equal(make(null,{...env,...overrides}).verifier,null);
});
test('actual official SDK request uses PNVS send, six digits, five minutes and no plaintext code return',async()=>{
  const {verifier,calls}=make();await verifier.send({phone,challengeId});assert.equal(calls.length,1);
  const {config,params,request,runtime}=calls[0];
  assert.equal(config.endpoint,'dypnsapi.aliyuncs.com');assert.equal(config.protocol,'HTTPS');
  assert.equal(params.action,'SendSmsVerifyCode');assert.equal(params.version,'2017-05-25');assert.equal(params.style,'RPC');
  assert.equal(params.method,'POST');assert.equal(params.authType,'AK');assert.equal(runtime.autoretry,false);assert.equal(runtime.maxAttempts,1);
  assert.deepEqual(request.query,{PhoneNumber:phone.slice(3),CountryCode:'86',OutId:challengeId,SchemeName:'synthetic-prod',
    SignName:'合成测试签名',TemplateCode:'100001',TemplateParam:'{"code":"##code##","min":"5"}',
    CodeLength:'6',CodeType:'1',ValidTime:'300',DuplicatePolicy:'1',Interval:'60',ReturnVerifyCode:'false'});
});
test('only PASS binds a proved phone; request success alone never verifies an OTP',async()=>{
  const {verifier,calls}=make();const proof=await verifier.verify({phone,challengeId,code:'123456'});
  assert.equal(calls[0].params.action,'CheckSmsVerifyCode');assert.equal(calls[0].request.query.VerifyCode,'123456');
  assert.equal(proof.phone,phone);assert.equal(proof.issuer,verifier.issuer);assert.match(proof.subject,/^[a-f0-9]{64}$/u);
  for(const model of [{OutId:challengeId,VerifyResult:'UNKNOWN'},{OutId:challengeId},{OutId:'other',VerifyResult:'PASS'}]) {
    const value=make(()=>ok(model));await assert.rejects(()=>value.verifier.verify({phone,challengeId,code:'123456'}),
      e=>e.code===(model.VerifyResult==='UNKNOWN'?'VALIDATION_FAILED':'SMS_UNAVAILABLE'));
  }
});
test('malformed/provider-error responses and lost responses are not retried or disclosed',async()=>{
  for(const reply of [{},{body:{Code:'OK',Success:false,Model:{OutId:challengeId,VerifyResult:'PASS'}}},
    {body:{Code:'DENIED',Success:true,Model:{OutId:challengeId,VerifyResult:'PASS'}}}]) {
    const value=make(()=>reply);await assert.rejects(()=>value.verifier.send({phone,challengeId}),e=>e.code==='SMS_UNAVAILABLE');assert.equal(value.calls.length,1);
  }
  const value=make(()=>{throw Error(`${env.ALIYUN_ACCESS_KEY_SECRET} 123456 ${phone}`);});
  await assert.rejects(()=>value.verifier.verify({phone,challengeId,code:'123456'}),e=>
    e.code==='SMS_UNAVAILABLE'&&!e.message.includes('synthetic-secret')&&!e.message.includes('123456'));
  assert.equal(value.calls.length,1);
});
test('captured credentials/scheme do not change during an in-flight request',async()=>{
  const mutable={...env};const {verifier,calls}=make(null,mutable);mutable.ALIYUN_PNVS_SIGN_NAME='changed';mutable.ALIYUN_ACCESS_KEY_ID='changed';
  await verifier.send({phone,challengeId});assert.equal(calls[0].config.accessKeyId,env.ALIYUN_ACCESS_KEY_ID);
  assert.equal(calls[0].request.query.SignName,env.ALIYUN_PNVS_SIGN_NAME);
  const defaults=make(null,{...env,ALIYUN_PNVS_SCHEME_NAME:''});await defaults.verifier.verify({phone,challengeId,code:'123456'});
  assert.equal(defaults.calls[0].request.query.SchemeName,undefined);
});
test('bad OTP and phone inputs invoke no provider request',async()=>{
  const {verifier,calls}=make();await assert.rejects(()=>verifier.verify({phone,challengeId,code:'1234'}),e=>e.code==='VALIDATION_FAILED');
  await assert.rejects(()=>verifier.send({phone:'+12125551234',challengeId}));assert.equal(calls.length,0);
});
test('Coze selection is phase-scoped, old route remains default, and credentials never borrow DEV values',()=>{
  assert.equal(cozePhoneProvider({COZE_PROJECT_ENV:'PROD'}),'supabase');
  const profile={COZE_PROJECT_ENV:'PROD',SMS_PROVIDER_PROD:'aliyun_pnvs',SMS_PROVIDER_DEV:'supabase',
    ALIYUN_ACCESS_KEY_ID_DEV:'not-production'};
  assert.equal(cozePhoneEnvironment(profile).ALIYUN_ACCESS_KEY_ID,undefined);
  assert.equal(cozePhoneProvider({...profile,COZE_PROJECT_ENV:'DEV'}),'supabase');
  assert.throws(()=>cozePhoneProvider({...profile,SMS_PROVIDER_PROD:'typo'}));
  assert(COZE_PHONE_BINDING_NAMES.includes('ALIYUN_ACCESS_KEY_SECRET_PROD'));
});
test('Coze prepares both configured adapters without sending; missing credentials stay unavailable',async()=>{
  let supabaseCalls=0,aliyunCalls=0;
  const phoneConfig={supabaseUrl:'https://synthetic.supabase.co',anonKey:'sb_publishable_synthetic_fixture_key_not_real'};
  const options={supabase:{fetch:async()=>{supabaseCalls++;return new Response('{}',{status:200});}},
    aliyun:{clientFactory:()=>({callApi:async(params,request)=>{aliyunCalls++;return ok({OutId:request.query.OutId});}})}};
  const scoped=Object.fromEntries(Object.entries(env).filter(([key])=>key!=='SMS_PROVIDER').map(([key,value])=>[key+'_PROD',value]));
  const profile={...scoped,COZE_PROJECT_ENV:'PROD',SMS_PROVIDER_PROD:'aliyun_pnvs'};
  const registry=configuredCozePhones(profile,phoneConfig,options);assert.equal(aliyunCalls,0);assert.equal(supabaseCalls,0);
  await registry.aliyun_pnvs.send({phone,challengeId});assert.equal(aliyunCalls,1);assert.equal(supabaseCalls,0);
  assert.equal(configuredCozePhones({...profile,ALIYUN_ACCESS_KEY_SECRET_PROD:''},phoneConfig,options).aliyun_pnvs,null);
  const old=registry.supabase;
  assert.equal(old.provider,'supabase');assert.equal(phoneConfig.supabaseUrl,'https://synthetic.supabase.co');
  await old.send({phone});assert.equal(supabaseCalls,1);assert.equal(aliyunCalls,1);
});
