import test from 'node:test';
import assert from 'node:assert/strict';
import {cozeGatewayAssistant,remoteCozeAssistant} from '../src/coze-assistant-transport.js';
import {prepareCozeAssistant,cozeAssistantJsonResult,COZE_ASSISTANT_PROTOCOL} from '../src/assistant-json-planner.js';
import {assistantErrorDiagnostic} from '../src/assistant-provider-errors.js';

// All fetches are replaced. These fixtures return decisions only; no model, phone, database or file tools run.
const model={execution:'coze',provider:'doubao',modelId:'doubao-seed-2-0-pro-260215'};
const context={baseUrl:'https://synthetic-model.invalid/v1',key:'synthetic-coze-stream-fixture-key',headers:{}};
const bridge={origin:'https://synthetic-bridge.invalid',environment:'DEV',key:context.key};
const wire=()=>({modelKey:'doubao-pro',requestId:'fixture_stream',mode:'chat',protocolVersion:2,timeoutSeconds:5,
  visionEnabled:false,availableTools:['search_apps','launch_app'],messages:[{role:'user',content:'合成流测试'}],
  thinking:{mode:'provider_default',effort:'provider_default'},maxOutputTokens:0,expectedModelId:model.modelId});
const plan=(content='你好',tool=null)=>JSON.stringify({content,tool});
const toolPlan=()=>plan(null,{name:'search_apps',arguments:{query:'测试应用'}});
const chunk=(delta={},finish_reason=null)=>({choices:[{index:0,delta,finish_reason}]});
const sse=value=>'data: '+JSON.stringify(value)+'\n\n';
const gateway=(request=wire(),signal=new AbortController().signal,callbacks)=>cozeGatewayAssistant(context,model,request,signal,callbacks);

function mocked(t,response){
  const originalFetch=globalThis.fetch,originalWarn=console.warn,logs=[];
  globalThis.fetch=async()=>typeof response==='function'?response():new Response(response,{headers:{'content-type':'text/event-stream'}});
  console.warn=value=>logs.push(JSON.parse(value));
  t.after(()=>{globalThis.fetch=originalFetch;console.warn=originalWarn;});
  return logs;
}

function bytesResponse(bytes){
  let offset=0;
  return new Response(new ReadableStream({pull(controller){
    if(offset===bytes.length)controller.close();else controller.enqueue(bytes.slice(offset,++offset));
  }}),{headers:{'content-type':'text/event-stream'}});
}

test('clean EOF with stop and complete JSON returns an ordinary answer without DONE',async t=>{
  mocked(t,sse(chunk({reasoning_content:'真实合成推理',content:plan('你好')},'stop')));
  const seen=[];
  const result=await gateway(wire(),new AbortController().signal,{onReasoning:async text=>seen.push(text)});
  assert.equal(result.choices[0].message.content,'你好');
  assert.equal(result.choices[0].finish_reason,'stop');
  assert.equal(result.choices[0].message.reasoning_content,seen.join(''));
});

test('clean EOF with stop still validates a complete tool name and arguments',async t=>{
  mocked(t,sse(chunk({content:toolPlan()},'stop')));
  const result=await gateway();
  const call=result.choices[0].message.tool_calls[0];
  assert.equal(call.function.name,'search_apps');
  assert.deepEqual(JSON.parse(call.function.arguments),{query:'测试应用'});
});

test('LF, CRLF, CR, heartbeats, UTF-8 byte boundaries and an unterminated final marker are framed correctly',async t=>{
  mocked(t,()=>new Response(''));
  for(const newline of ['\n','\r\n','\r']){
    const payload=JSON.stringify(chunk({content:plan('跨字节中文')},'stop')),split=payload.indexOf('[');
    const body=': heartbeat'+newline+newline+'event: message'+newline+'data: '+payload.slice(0,split)+newline+
      'data: '+payload.slice(split)+newline+newline+'data: [DONE]'+newline+newline+': heartbeat'+newline+'data: [DONE]  ';
    globalThis.fetch=async()=>bytesResponse(new TextEncoder().encode(body));
    assert.equal((await gateway()).choices[0].message.content,'跨字节中文');
  }
});

test('a complete final stop frame without a blank line is accepted only at clean EOF',async t=>{
  mocked(t,'data: '+JSON.stringify(chunk({content:plan('完整尾帧')},'stop')));
  assert.equal((await gateway()).choices[0].message.content,'完整尾帧');
});

test('usage, comments and identical empty terminal metadata do not become extra model output',async t=>{
  mocked(t,sse(chunk({content:plan('收尾完成')},''))+sse(chunk({},'stop'))+sse(chunk({},'stop'))+
    sse({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+': heartbeat\n\n');
  assert.equal((await gateway()).choices[0].message.content,'收尾完成');
});

test('no finish, reasoning-only, truncated JSON, length and filtering remain distinct failures',async t=>{
  mocked(t,()=>new Response(''));
  const cases=[
    [sse(chunk({reasoning_content:'只有推理'})),'MODEL_STREAM_INCOMPLETE',/只返回了思考/],
    [sse(chunk({reasoning_content:'只有推理'},'stop')),'MODEL_RESPONSE_EMPTY',/缺少正式回复/],
    [sse(chunk({content:toolPlan()}))+'data: [DONE]\n\n','MODEL_STREAM_INCOMPLETE',/正常结束状态/],
    [sse(chunk({content:'{"content":null,"tool":'},'stop')),'MODEL_JSON_PLAN_INVALID',/完整JSON/],
    [sse(chunk({content:'{"content":'},'length')),'MODEL_OUTPUT_TRUNCATED',/输出长度限制/],
    [sse(chunk({},'content_filter')),'MODEL_OUTPUT_BLOCKED',/内容审核/],
  ];
  for(const [body,code,message] of cases){
    globalThis.fetch=async()=>new Response(body,{headers:{'content-type':'text/event-stream'}});
    await assert.rejects(gateway(),error=>error.code===code&&message.test(error.message));
  }
});

test('a valid stop signal never authorizes unknown tools or schema-invalid arguments',async t=>{
  mocked(t,()=>new Response(''));
  for(const tool of [{name:'unknown_tool',arguments:{}},{name:'launch_app',arguments:{package_name:17}}]){
    globalThis.fetch=async()=>new Response(sse(chunk({content:plan(null,tool)},'stop')),{headers:{'content-type':'text/event-stream'}});
    await assert.rejects(gateway(),error=>error.code==='MODEL_JSON_PLAN_INVALID');
  }
});

test('conflicting terminal states and new content after stop cannot produce a decision',async t=>{
  mocked(t,()=>new Response(''));
  for(const late of [chunk({},'length'),chunk({content:'晚到正文'}),chunk({reasoning_content:'晚到思考'})]){
    globalThis.fetch=async()=>new Response(sse(chunk({content:toolPlan()},'stop'))+sse(late)+'data: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
    await assert.rejects(gateway(),error=>error.code==='MODEL_STREAM_INCOMPLETE');
  }
});

test('a provider error after stop is read before returning any executable decision',async t=>{
  mocked(t,sse(chunk({content:toolPlan()},'stop'))+sse({error:{code:'service_unavailable_error',message:'Service is too busy'}}));
  await assert.rejects(gateway(),error=>error.code==='MODEL_SERVICE_BUSY');
});

test('a stream read failure is not treated as a clean EOF even after stop',async t=>{
  mocked(t,()=>new Response(new ReadableStream({
    start(controller){controller.enqueue(new TextEncoder().encode(sse(chunk({content:toolPlan()},'stop'))));},
    pull(controller){controller.error(new Error('synthetic socket failure'));},
  }),{headers:{'content-type':'text/event-stream'}}));
  await assert.rejects(gateway());
});

test('invalid UTF-8 tails are reported as encoding failures and never executed',async t=>{
  const data=new TextEncoder().encode(sse(chunk({content:toolPlan()},'stop')));
  const broken=new Uint8Array(data.length+1);broken.set(data);broken[data.length]=0xe4;
  mocked(t,()=>bytesResponse(broken));
  await assert.rejects(gateway(),error=>error.code==='MODEL_RESPONSE_ENCODING_INVALID');
});

test('cancellation while reasoning is emitted discards the otherwise complete answer',async t=>{
  mocked(t,sse(chunk({reasoning_content:'合成推理',content:toolPlan()},'stop')));
  const controller=new AbortController();
  await assert.rejects(gateway(wire(),controller.signal,{onReasoning:async()=>controller.abort()}),
    error=>error.code==='ASSISTANT_REQUEST_CANCELLED');
});

test('only safe completion observations enter diagnostics and logs',async t=>{
  const logs=mocked(t,sse(chunk({reasoning_content:'只有思考'})));
  let caught;try{await gateway();}catch(error){caught=error;}
  const diagnostic=assistantErrorDiagnostic(caught);
  assert.equal(diagnostic.stream_done_seen,false);assert.equal(diagnostic.stream_eof_seen,true);
  assert.equal(diagnostic.answer_received,false);assert.equal(diagnostic.reasoning_received,true);
  assert.equal(diagnostic.retryable,false);
  assert.equal(diagnostic.upstream_finish_reason,undefined);
  assert.equal(JSON.stringify(logs).includes('只有思考'),false);
  globalThis.fetch=async()=>new Response(sse(chunk({content:toolPlan()},context.key)),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(gateway(),error=>!JSON.stringify({message:error.message,diagnostic:assistantErrorDiagnostic(error)}).includes(context.key));
  assert.equal(JSON.stringify(logs).includes(context.key),false);
});

test('legacy connection probes keep actual final usage instead of inventing missing counts',async t=>{
  const request={modelKey:'doubao-pro',requestId:'fixture_probe',mode:'connection_test',timeoutSeconds:5,
    messages:[{role:'user',content:'Call connection_probe exactly once with nonce: fixture_nonce'}]};
  const content=plan(null,{name:'connection_probe',arguments:{nonce:'fixture_nonce'}});
  mocked(t,sse(chunk({content},'stop'))+sse({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}}));
  assert.deepEqual((await gateway(request)).usage,{prompt_tokens:10,completion_tokens:5,total_tokens:15});
  globalThis.fetch=async()=>new Response(sse(chunk({content},'stop')),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(gateway(request),error=>error.code==='MODEL_USAGE_MISSING');
});

function bridgeFixture(request=wire(),content=toolPlan()){
  const prepared=prepareCozeAssistant(model,request);
  const envelope={projectId:'7689833705046130729',environment:'DEV',requestId:request.requestId,planningProtocol:COZE_ASSISTANT_PROTOCOL};
  const result={...cozeAssistantJsonResult(content,prepared.request),configuration:prepared.configuration};
  return {envelope,result};
}

test('the HMAC bridge accepts clean EOF only after an identified complete validated result',async t=>{
  const {envelope,result}=bridgeFixture();
  mocked(t,sse(envelope)+'data: '+JSON.stringify({result}));
  const answer=await remoteCozeAssistant(bridge)(model,wire(),new AbortController().signal);
  assert.equal(answer.choices[0].message.tool_calls[0].function.name,'search_apps');
});

test('bridge reasoning without a terminal result and identity mismatch are never decisions',async t=>{
  const {envelope,result}=bridgeFixture();
  mocked(t,sse(envelope)+sse({reasoning_content:'还没有正文'}));
  await assert.rejects(remoteCozeAssistant(bridge)(model,wire(),new AbortController().signal),error=>error.code==='MODEL_STREAM_INCOMPLETE');
  globalThis.fetch=async()=>new Response(sse({...envelope,requestId:'wrong_fixture'})+sse({result}),{headers:{'content-type':'text/event-stream'}});
  await assert.rejects(remoteCozeAssistant(bridge)(model,wire(),new AbortController().signal),error=>error.code==='COZE_ASSISTANT_IDENTITY_INVALID');
});

test('a complete bridge envelope cannot bypass tool-schema validation or a late error',async t=>{
  const {envelope,result}=bridgeFixture();
  const invalid=structuredClone(result);invalid.choices[0].message.tool_calls[0].function.arguments='{"query":17}';
  mocked(t,sse(envelope)+sse({result:invalid}));
  await assert.rejects(remoteCozeAssistant(bridge)(model,wire(),new AbortController().signal));
  globalThis.fetch=async()=>new Response(sse(envelope)+sse({result})+sse({error:{code:'MODEL_SERVICE_BUSY',message:'合成后续错误'}}),
    {headers:{'content-type':'text/event-stream'}});
  await assert.rejects(remoteCozeAssistant(bridge)(model,wire(),new AbortController().signal),error=>error.code==='MODEL_SERVICE_BUSY');
});

test('cancellation from bridge configuration prevents late text and tool delivery',async t=>{
  const {envelope,result}=bridgeFixture(wire(),plan('不应晚到的文本'));
  mocked(t,sse(envelope)+sse({configuration:result.configuration})+sse({result}));
  const controller=new AbortController(),texts=[];
  await assert.rejects(remoteCozeAssistant(bridge)(model,wire(),controller.signal,async text=>texts.push(text),async()=>{},
    async()=>controller.abort()),error=>error.code==='ASSISTANT_REQUEST_CANCELLED');
  assert.deepEqual(texts,[]);
});
