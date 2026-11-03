import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareCozeAssistant,cozeAssistantJsonResult} from '../src/assistant-json-planner.js';
import {cozeGatewayAssistant} from '../src/coze-assistant-transport.js';

// Definitions only: synthetic model output, no phone/file execution or real provider request.
const model={execution:'coze',provider:'doubao',modelId:'doubao-seed-2-0-pro-260215'};
const wire=(requestId='fixture_json_1',messages=[{role:'user',content:'打开测试应用'}])=>({
  modelKey:'doubao-pro',requestId,mode:'chat',protocolVersion:2,timeoutSeconds:5,visionEnabled:false,
  availableTools:['search_apps','launch_app'],messages,thinking:{mode:'provider_default',effort:'provider_default'},maxOutputTokens:0,
  expectedModelId:model.modelId,
});
const output=(name,args,content=null)=>JSON.stringify({content,tool:{name,arguments:args}});

test('JSON planning preserves actual tool ids, full arguments and matching results across rounds',()=>{
  const first=prepareCozeAssistant(model,wire());
  const decided=cozeAssistantJsonResult(output('search_apps',{query:'测试应用'}),first.request);
  const message=decided.choices[0].message,call=message.tool_calls[0];
  assert.equal(call.id,'coze_json_fixture_json_1');
  const receipt=JSON.stringify({ok:true,apps:[{package_name:'com.fixture.example',label:'测试应用'}]});
  const next=prepareCozeAssistant(model,wire('fixture_json_2',[
    {role:'user',content:'打开测试应用'},message,{role:'tool',tool_call_id:call.id,content:receipt},
  ]));
  assert.equal(next.body.messages.some(item=>item.role==='tool'),false);
  const history=JSON.parse(next.body.messages.find(item=>item.role==='assistant').content);
  assert.equal(history.tool.id,call.id);
  assert.deepEqual(history.tool.arguments,{query:'测试应用'});
  const resultMessage=next.body.messages.find(item=>typeof item.content==='string'&&item.content.startsWith('TOOL_RESULT\n'));
  assert.deepEqual(JSON.parse(resultMessage.content.slice('TOOL_RESULT\n'.length)),{tool_call_id:call.id,content:receipt});
  const second=cozeAssistantJsonResult(output('launch_app',{package_name:'com.fixture.example'}),next.request);
  assert.equal(second.choices[0].message.tool_calls[0].function.name,'launch_app');
  assert.equal(second.planningProtocol,'coze_json_v1');
  assert.equal(second.toolCallIdSource,'adapter');
});

test('incomplete JSON, unknown tools and schema-invalid parameters never become executable decisions',()=>{
  const prepared=prepareCozeAssistant(model,wire());
  for(const raw of ['{"content":null,"tool":',output('not_implemented',{}),output('launch_app',{package_name:3}),
    JSON.stringify({content:'仅文字',tool:null,reasoning:'不能伪造思考'})]){
    assert.throws(()=>cozeAssistantJsonResult(raw,prepared.request));
  }
});

test('JSON thinking fields cannot masquerade as real API reasoning; output default is omitted',()=>{
  const prepared=prepareCozeAssistant(model,wire());
  assert.equal('thinking' in prepared.body,false);
  assert.equal('max_tokens' in prepared.body,false);
  assert.equal('tools' in prepared.body,false);
  const result=cozeAssistantJsonResult(JSON.stringify({content:'可以继续交流',tool:null}),prepared.request);
  assert.equal('reasoning_content' in result.choices[0].message,false);
  const enabled=prepareCozeAssistant(model,{...wire(),thinking:{mode:'enabled',effort:'provider_default'},maxOutputTokens:1200});
  assert.deepEqual(enabled.body.thinking,{type:'enabled'});
  assert.equal(enabled.body.max_tokens,1200);
});

test('one SSE frame keeps reasoning and JSON content independent, then validates before exposing a tool',async t=>{
  const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
  const raw=output('search_apps',{query:'测试应用'});
  let sent,sentHeaders;
  globalThis.fetch=async(_url,options)=>{
    sent=JSON.parse(options.body);
    sentHeaders=new Headers(options.headers);
    return new Response('data: '+JSON.stringify({choices:[{delta:{reasoning_content:'真实接口推理',content:raw},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n',
      {headers:{'content-type':'text/event-stream'}});
  };
  const reasoning=[];
  const result=await cozeGatewayAssistant({baseUrl:'https://model.coze.cn/v1',key:'synthetic-key-for-source-definition',
    headers:{Authorization:'Bearer synthetic-key-for-source-definition'}},
    model,wire(),new AbortController().signal,{onReasoning:async text=>{reasoning.push(text);}});
  assert.equal(reasoning.join(''),'真实接口推理');
  assert.equal(result.choices[0].message.reasoning_content,'真实接口推理');
  assert.equal(result.choices[0].message.tool_calls[0].function.name,'search_apps');
  assert.equal('tools' in sent,false);
  assert.equal(sentHeaders.get('authorization'),'Bearer synthetic-key-for-source-definition');
});

test('cancelled response and missing stream terminal cannot produce an executable decision',async t=>{
  const oldFetch=globalThis.fetch;t.after(()=>{globalThis.fetch=oldFetch;});
  const controller=new AbortController();
  globalThis.fetch=async()=>{controller.abort();return new Response('{}',{headers:{'content-type':'application/json'}});};
  await assert.rejects(cozeGatewayAssistant({baseUrl:'https://model.coze.cn/v1',key:'synthetic-key-for-source-definition',headers:{}},
    model,wire(),controller.signal),error=>error.code==='ASSISTANT_REQUEST_CANCELLED');
  globalThis.fetch=async()=>new Response('data: '+JSON.stringify({choices:[{delta:{content:output('search_apps',{query:'测试应用'})},finish_reason:null}]})+'\n\n',
    {headers:{'content-type':'text/event-stream'}});
  await assert.rejects(cozeGatewayAssistant({baseUrl:'https://model.coze.cn/v1',key:'synthetic-key-for-source-definition',headers:{}},
    model,wire(),new AbortController().signal),error=>error.code==='MODEL_STREAM_INCOMPLETE');
});
