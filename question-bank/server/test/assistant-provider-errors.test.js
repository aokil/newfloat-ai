import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantProviderDiagnostic,readAssistantProviderDiagnostic,assistantProviderError,assistantTransportError,
  assistantErrorDiagnostic,assistantBackendDiagnostic,reportAssistantFailure} from '../src/assistant-provider-errors.js';
import {officialAssistantChat} from '../src/assistant-model-transport.js';

const secret='synthetic-unit-secret-not-a-production-credential';
const context={provider:'deepseek',modelId:'deepseek-flash',requestId:'assistant-unit-diagnostic',timeoutSeconds:45,secret};
const upstreamId='00000000-0000-4000-8000-000000000503';

test('the observed busy response survives the actual HTTP transport with one request and safe diagnostics',async t=>{
  const originalFetch=globalThis.fetch,originalWarn=console.warn,logs=[];let calls=0;
  t.after(()=>{globalThis.fetch=originalFetch;console.warn=originalWarn;});
  console.warn=value=>logs.push(String(value));
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({error:{code:'service_unavailable_error',type:'service_unavailable_error',param:null,
    message:`Service is too busy. We advise users to temporarily switch to alternative LLM API service providers. (request_id: ${upstreamId})`}}),
    {status:503,headers:{'content-type':'application/json'}});};
  let error;
  try{await officialAssistantChat({provider:'deepseek',baseUrl:'https://api.deepseek.com',modelId:'deepseek-flash',execution:'official'},secret,
    {messages:[{role:'user',content:'synthetic diagnostic'}],tools:[],timeoutSeconds:5,protocolVersion:2,requestId:context.requestId},new AbortController().signal);}
  catch(value){error=value;}
  assert.ok(error);assert.equal(calls,1);assert.equal(logs.length,1);
  assert.equal(error.statusCode,503);
  assert.equal(error.code,'MODEL_SERVICE_BUSY');
  assert.match(error.message,/DeepSeek服务繁忙/u);
  assert.match(error.message,/上游HTTP 503/u);
  assert.ok(error.message.includes(upstreamId));
  assert.ok(!error.message.includes('We advise users'));
  assert.equal(assistantErrorDiagnostic(error).provider_error_code,'service_unavailable_error');
  assert.equal(assistantErrorDiagnostic(error).upstream_request_id,upstreamId);
  assert.ok(!JSON.stringify(logs).includes(secret));
});

test('balance, authorization, access policy, rate limit and context errors remain distinct',()=>{
  const cases=[
    [402,{},'MODEL_BALANCE_OR_QUOTA_UNAVAILABLE',/余额不足/u,false],
    [401,{},'MODEL_AUTH_UNAVAILABLE',/鉴权失败/u,false],
    [403,{},'MODEL_ACCESS_DENIED',/拒绝访问/u,false],
    [429,{},'MODEL_RATE_LIMITED',/频率或并发/u,true],
    [400,{code:'context_length_exceeded'},'MODEL_CONTEXT_EXCEEDED',/上下文/u,false],
    [422,{param:'thinking.type',message:'invalid field'},'THINKING_PARAMETER_REJECTED',/thinking.type/u,false],
    [504,{},'MODEL_UPSTREAM_TIMEOUT',/上游网关返回响应超时/u,true],
  ];
  for(const [status,info,code,reason,retryable] of cases){
    const error=assistantProviderError(status,info,context);
    assert.equal(error.code,code);assert.match(error.message,reason);
    assert.equal(assistantErrorDiagnostic(error).upstream_http_status,status);
    assert.equal(assistantErrorDiagnostic(error).retryable,retryable);
  }
});

test('unclassified HTML gateway failures preserve the observed status without inventing a cause',async()=>{
  const response=new Response('<html>private upstream body</html>',{status:520});
  const error=assistantProviderError(response.status,await readAssistantProviderDiagnostic(response,secret),context);
  assert.equal(error.code,'MODEL_UPSTREAM_FAILED');
  assert.match(error.message,/尚未分类/u);assert.match(error.message,/520/u);
  assert.ok(!error.message.includes('private upstream body'));
});

test('credential echoes and arbitrary error text never enter public diagnostics or narrow logs',t=>{
  const info=assistantProviderDiagnostic({error:{code:secret,type:'service_unavailable_error',param:secret,
    message:`private-user-content password=private-data (request_id: ${secret})`}},new Headers({'x-request-id':secret}),secret);
  const error=assistantProviderError(503,info,context);
  const output=[];const original=console.warn;console.warn=value=>output.push(String(value));t.after(()=>{console.warn=original;});
  const reported=reportAssistantFailure(error,context);
  const publicText=JSON.stringify({message:reported.message,diagnostic:assistantErrorDiagnostic(reported),logs:output});
  for(const forbidden of [secret,'private-user-content','private-data'])assert.ok(!publicText.includes(forbidden));
  assert.equal(output.length,1);
  assert.match(output[0],/assistant_model_failure/u);
  assert.ok(reported.message.includes(context.requestId));
});

test('an error inside an established stream is identified as a stream failure',()=>{
  const info=assistantProviderDiagnostic({error:{code:'service_unavailable_error',message:'Service is too busy.'}},null,secret);
  const error=assistantProviderError(200,info,{...context,phase:'provider_stream'});
  assert.equal(error.code,'MODEL_SERVICE_BUSY');
  assert.match(error.message,/流连接HTTP 200/u);
  assert.equal(assistantErrorDiagnostic(error).phase,'provider_stream');
});

test('DNS, TLS, connection interruption and the backend timer identify the actual failed layer',()=>{
  assert.equal(assistantTransportError({cause:{code:'ENOTFOUND'}},context).code,'MODEL_DNS_FAILED');
  assert.equal(assistantTransportError({cause:{code:'CERT_HAS_EXPIRED'}},context).code,'MODEL_TLS_FAILED');
  assert.equal(assistantTransportError({cause:{code:'ECONNRESET'}},context).code,'MODEL_CONNECTION_FAILED');
  const timeout=assistantTransportError(null,context,true);
  assert.equal(timeout.code,'MODEL_TIMEOUT');assert.match(timeout.message,/45秒/u);
  assert.equal(assistantErrorDiagnostic(timeout).upstream_http_status,undefined);
});

test('backend correlation IDs and stack locations never copy multiline exception messages',t=>{
  const logs=[],original=console.warn;console.warn=value=>logs.push(String(value));t.after(()=>{console.warn=original;});
  const error=new TypeError(`private-user-content\nat ${secret}.js:12:34`);
  const data=assistantBackendDiagnostic(error,{phase:'backend_stream',code:'MODEL_CHAT_FAILED'});
  assert.match(data.request_id,/^assistant_error_[a-f0-9-]{36}$/u);
  assert.equal(data.phase,'backend_stream');assert.equal(data.exception_type,'TypeError');
  assert.equal(data.upstream_http_status,undefined);assert.equal(data.backend_http_status,undefined);
  assert.equal(logs.length,1);
  for(const value of ['private-user-content',secret])assert.ok(!logs[0].includes(value));
});
