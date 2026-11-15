import test from 'node:test';
import assert from 'node:assert/strict';
import {testApp,register,call} from './helpers.js';

const MINI='doubao-seed-2-0-mini-260215';
const image={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xGQAAAAASUVORK5CYII='};
const usage={prompt_tokens:12,completion_tokens:28,total_tokens:40};
const extracted={complete:true,rawText:'合成题目\nA. 合成甲\nB. 合成乙',stem:'合成题目',options:[{id:'A',text:'合成甲'},{id:'B',text:'合成乙'}]};

async function fixture(t,balance=1){
  const state={calls:0,answers:0,answer:'A',images:true,result:{...extracted,usage},error:null};
  const bridge={ready:true,
    async metadata(){return {projectId:'7689833705046130729',environment:'DEV',items:[{model_id:MINI,model_name:'Synthetic Mini',input_types:state.images?['text','image']:['text'],output_types:['text']}]};},
    async test(){return {status:'passed',usage,latencyMs:1,providerRequestId:'synthetic-ocr-test'};},
    async search(){state.answers++;return {answer:state.answer,explanation:'',usage};},
    async extract(config,payload,context){
      state.calls++;assert.equal(config.modelId,MINI);assert.equal(config.maxOutputTokens,4096);assert.deepEqual(payload,image);assert.match(context.requestId,/^ai_/u);
      if(state.error)throw new Error(state.error);return state.result;
    }};
  const app=await testApp({cozeBridge:bridge});t.after(()=>app.close());
  const owner=await register(app,'synthetic-ocr-owner');
  // Synthetic in-memory fixture only; never connects to a production account.
  await app.store.run("UPDATE users SET role='admin',points_balance=?,points_reserved=0 WHERE id=?",balance,owner.principal.userId);
  let r=await call(app,'POST','/v1/admin/models',owner.accessToken,{execution:'coze',provider:'doubao',displayName:'Synthetic Mini',modelId:MINI,baseUrl:null,enabled:false,capabilities:['text'],maxOutputTokens:2048,timeoutMs:30000,pointsPerCall:1,catalogKey:'doubao-mini'},'ocr-model-create');
  assert.equal(r.statusCode,200,r.body);const model=r.json();
  r=await call(app,'POST',`/v1/admin/models/${model.id}/test`,owner.accessToken,{expectedRevision:model.revision},'ocr-model-test');assert.equal(r.json().status,'passed',r.body);
  r=await call(app,'PATCH',`/v1/admin/models/${model.id}`,owner.accessToken,{enabled:true,expectedRevision:model.revision},'ocr-model-enable');assert.equal(r.statusCode,200,r.body);
  return {app,owner,state};
}
const balance=async(app,owner)=>({...await app.store.get('SELECT points_balance,points_reserved FROM users WHERE id=?',owner.principal.userId)});

test('an extracted A/B judgment accepts a truth-only search answer and settles each stage once',async t=>{
  const {app,owner,state}=await fixture(t,5);
  const stem='判断 长期服用依赖性精神药品成瘾尚未戒除的，将被注销驾驶证。';
  state.result={complete:true,rawText:`${stem}\nA. 正确\nB. 错误`,stem,
    options:[{id:'A',text:'正确'},{id:'B',text:'错误'}],usage};
  let r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},'judgment-extraction');
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().pointsCharged,1);
  state.answer='对';
  const body={mode:'builtin',modelKey:'doubao-mini',question:state.result.rawText};
  r=await call(app,'POST','/v1/ai/search',owner.accessToken,body,'judgment-search');
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().answer,'对');assert.equal(r.json().pointsCharged,1);
  assert.deepEqual(await balance(app,owner),{points_balance:3,points_reserved:0});
  r=await call(app,'POST','/v1/ai/search',owner.accessToken,body,'judgment-search');
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().answer,'对');
  assert.equal(state.calls,1);assert.equal(state.answers,1);
  assert.deepEqual(await balance(app,owner),{points_balance:3,points_reserved:0});
});

test('OCR settles the last point once, retains a zero-balance receipt and isolates the answer purpose',async t=>{
  const {app,owner,state}=await fixture(t);
  const catalog=await call(app,'GET','/v1/models/catalog',owner.accessToken);assert.equal(catalog.json().ocrExtraction.available,true);
  let r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},'synthetic-ocr-last-point');
  assert.equal(r.statusCode,200,r.body);assert.equal(r.json().source,'ai-ocr');assert.equal(r.json().purpose,'ocr-extraction-v1');assert.equal(r.json().pointsCharged,1);assert.equal(r.json().pointsAvailable,0);assert.equal(r.json().answer,undefined);
  assert.deepEqual(await balance(app,owner),{points_balance:0,points_reserved:0});
  r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},'synthetic-ocr-last-point');assert.equal(r.statusCode,200,r.body);assert.equal(state.calls,1);
  r=await call(app,'GET','/v1/ai/receipt',owner.accessToken,undefined,'synthetic-ocr-last-point');assert.equal(r.statusCode,200,r.body);assert.equal(r.json().stem,extracted.stem);assert.equal(r.json().pointsAvailable,0);
  r=await call(app,'POST','/v1/ai/search',owner.accessToken,{mode:'builtin',modelKey:'doubao-mini',question:'合成题目\nA. 合成甲\nB. 合成乙'},'synthetic-ocr-last-point');assert.equal(r.statusCode,409,r.body);
  r=await call(app,'POST','/v1/ai/search',owner.accessToken,{mode:'builtin',modelKey:'doubao-mini',question:'合成题目\nA. 合成甲\nB. 合成乙'},'synthetic-answer-no-points');assert.equal(r.statusCode,403,r.body);assert.equal(state.answers,0);
  assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger WHERE user_id=? AND delta<0',owner.principal.userId)).n,1);
});

test('incomplete, invalid and timed-out OCR releases its reservation and never retries the supplier',async t=>{
  const {app,owner,state}=await fixture(t);
  for(const [index,result,error,code] of [
    [0,{complete:false,usage},null,'OCR_INCOMPLETE'],
    [1,{...extracted,stem:'',usage},null,'OCR_RESPONSE_INVALID'],
    [2,{...extracted,usage},'TIMEOUT_UNKNOWN','TIMEOUT_UNKNOWN'],
    [3,{...extracted,usage:undefined},null,'USAGE_MISSING'],
  ]){
    state.result=result;state.error=error;const key='synthetic-ocr-failure-'+index;
    let r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},key);assert.equal(r.statusCode,502,r.body);assert.equal(r.json().error.code,code);
    assert.deepEqual(await balance(app,owner),{points_balance:1,points_reserved:0});const calls=state.calls;
    r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},key);assert.equal(r.json().error.code,code);assert.equal(state.calls,calls);
  }
  assert.equal((await app.store.get('SELECT COUNT(*) n FROM points_ledger WHERE user_id=? AND delta<0',owner.principal.userId)).n,0);
});

test('OCR requires auth and image capability and does not accept a caller-chosen model or price',async t=>{
  const {app,owner,state}=await fixture(t);
  let r=await call(app,'POST','/v1/ai/extract',null,{image},'anonymous-ocr');assert.equal(r.statusCode,401);
  r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image,modelKey:'doubao-pro',pointsPerCall:0},'ocr-override');assert.equal(r.statusCode,400,r.body);
  state.images=false;
  r=await call(app,'GET','/v1/models/catalog',owner.accessToken);assert.equal(r.json().ocrExtraction.available,false);
  r=await call(app,'POST','/v1/ai/extract',owner.accessToken,{image},'unsupported-ocr');assert.equal(r.statusCode,422,r.body);assert.equal(r.json().error.code,'MODEL_IMAGE_UNSUPPORTED');
  assert.equal(state.calls,0);assert.deepEqual(await balance(app,owner),{points_balance:1,points_reserved:0});
});
