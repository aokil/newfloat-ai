import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantRequest,assistantTools,assistantTurnResult} from '../src/assistant-protocol.js';

// Synthetic definitions only: no server, model, account, phone or network request.
const failure={ok:false,code:'EVIDENCE_INSUFFICIENT',stage:'verification',action_submitted:false,
  accepted:null,verification:'not_available'};
const history=(args,receipt=failure,name='finish')=>[
  {role:'user',content:'合成手机任务'},
  {role:'assistant',content:null,tool_calls:[{id:'fixture_finish',type:'function',
    function:{name,arguments:JSON.stringify(args)}}]},
  {role:'tool',tool_call_id:'fixture_finish',content:JSON.stringify(receipt)},
  {role:'user',content:'继续合成任务'}
];
const request=messages=>assistantRequest({modelKey:'deepseek-flash',mode:'chat',requestId:'synthetic_finish_history',
  protocolVersion:2,phoneToolsVersion:2,availableTools:['finish'],visionEnabled:false,messages});
const turn=args=>({choices:[{finish_reason:'tool_calls',message:{role:'assistant',content:null,
  tool_calls:[{id:'fixture_new_finish',type:'function',function:{name:'finish',arguments:JSON.stringify(args)}}]}}]});

test('new finish calls require both evidence fields',()=>{
  const tools=assistantTools('session',false,2);
  for(const args of [{summary:'合成结果'},{summary:'合成结果',evidence_text:'合成证据'},
    {summary:'合成结果',evidence_package_name:'fixture.app'}]){
    const value=assistantTurnResult(turn(args),tools);
    assert.equal(value.tool_validation.ok,false);
    assert.equal(value.tool_validation.code,'TOOL_SCHEMA_INVALID');
  }
  assert.equal(assistantTurnResult(turn({summary:'合成结果',evidence_text:'合成证据',evidence_package_name:'fixture.app'}),tools).tool_validation.ok,true);
});

test('old missing-citation finish remains readable only with its closed failure receipt',()=>{
  const messages=history({summary:'旧合成结果'});
  const value=request(messages);
  assert.equal(value.messages[2].tool_calls[0].function.arguments,messages[1].tool_calls[0].function.arguments);
  assert.deepEqual(value.tools[0].function.parameters.required,['summary','evidence_text','evidence_package_name']);
});

test('old histories may be missing either citation field without inventing it',()=>{
  for(const args of [{summary:'旧合成结果',evidence_text:'合成证据'},
    {summary:'旧合成结果',evidence_package_name:'fixture.app'}]){
    const value=request(history(args));
    assert.deepEqual(JSON.parse(value.messages[2].tool_calls[0].function.arguments),args);
  }
});

test('a legacy failure exception never accepts a fabricated success or an accepted action',()=>{
  for(const changed of [{ok:true},{code:'RESULT_VERIFIED'},{action_submitted:true},{accepted:true},
    {verification:'passed'},{stage:'execution'}]){
    assert.throws(()=>request(history({summary:'旧合成结果'},{...failure,...changed})),
      error=>error.code==='ASSISTANT_HISTORY_INVALID');
  }
});

test('a malformed old finish is not covered by the citation-only exception',()=>{
  for(const args of [{summary:7},{summary:'旧合成结果',unknown_field:'合成值'},
    {summary:'旧合成结果',evidence_text:7}]){
    assert.throws(()=>request(history(args)),error=>error.code==='ASSISTANT_HISTORY_INVALID');
  }
});

test('another invalid tool cannot borrow an evidence failure receipt',()=>{
  assert.throws(()=>request(history({node_id:7},failure,'tap')),error=>error.code==='ASSISTANT_HISTORY_INVALID');
});

test('the old failure pair must still be complete and have matching call IDs',()=>{
  const missing=history({summary:'旧合成结果'});missing.splice(2,1);
  assert.throws(()=>request(missing),error=>error.code==='ASSISTANT_HISTORY_INVALID');
  const mismatch=history({summary:'旧合成结果'});mismatch[2].tool_call_id='other_call';
  assert.throws(()=>request(mismatch),error=>error.code==='ASSISTANT_HISTORY_INVALID');
});

test('normal complete finish history and unsubmitted schema-error history remain compatible',()=>{
  assert.doesNotThrow(()=>request(history({summary:'合成结果',evidence_text:'合成证据',evidence_package_name:'fixture.app'},
    {ok:true,code:'RESULT_VERIFIED',stage:'verification',action_submitted:false,accepted:null,verification:'passed'})));
  assert.doesNotThrow(()=>request(history({summary:'合成结果'},{ok:false,code:'TOOL_SCHEMA_INVALID',action_submitted:false})));
});
