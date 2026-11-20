import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {AsyncSqliteStore} from '../src/async-store.js';
import {importRepairJobs,importRepairRoutes} from '../src/import-repair-routes.js';
import {importRepairRequest,importRepairResult,importRepairModel} from '../src/import-repair.js';
import {cozeGatewayImportRepair} from '../src/import-repair-transport.js';
import binding from '../src/import-repair-model-binding.json' with {type:'json'};
import catalogueEvidence from './fixtures/import-repair-model-catalog-20261119.json' with {type:'json'};
import {createHash} from 'node:crypto';
const MODEL='doubao-seed-2-1-turbo-260628';
const wire=()=>({schemaVersion:1,groupId:'row_1',sourceHash:'a'.repeat(64),sources:[{id:'s1',text:'单选题\n天空颜色？\nA. 蓝色\nB. 绿色\n答案：A'}],candidate:{stem:'天空颜色？',sourceName:'合成'},reasons:['选项换行异常']});
const repaired=()=>({status:'repaired',diagnosis:'恢复原选项分行',questions:[{questionType:'single_choice',stem:'天空颜色？',options:[{id:'A',text:'蓝色'},{id:'B',text:'绿色'}],answerText:'',answerOptionIds:['A'],answerBoolean:null,answerParts:[],expectedBlankCount:null,answerComplete:true,explanation:'',sourceName:'合成',evidence:[
  {field:'questionType',sourceId:'s1',quote:'单选题'},{field:'stem',sourceId:'s1',quote:'天空颜色？'},
  {field:'options.A',sourceId:'s1',quote:'A. 蓝色'},{field:'options.B',sourceId:'s1',quote:'B. 绿色'},
  {field:'answerOptionIds',sourceId:'s1',quote:'答案：A'}]}]});
const usage={inputTokens:20,outputTokens:30,totalTokens:50};
function bridge(run){const state={calls:0};return {state,ready:true,metadata:async()=>({source:'live-sdk',items:[{model_id:MODEL}]}),
  async importRepair(model,input,execution){assert.equal(model,MODEL);execution.onSubmitted();state.calls++;return run?run(execution):{result:repaired(),usage,providerRequestId:'synthetic_1'};}};}
async function database(t){const store=await AsyncSqliteStore.open(':memory:');for(const owner of ['one','two'])await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at) VALUES(?,?,?,?,?,?)',owner,owner,owner,'unused','user',1);t.after(()=>store.close());return store;}

test('request bounds reject unsupported fields, duplicate blocks and bulk input',()=>{
  assert.deepEqual(importRepairRequest(wire()),wire());
  for(const change of [{modelId:'forbidden'},{sources:[{id:'s1',text:'x'.repeat(12001)}]},{sources:[wire().sources[0],wire().sources[0]]},{reasons:[]},{sourceHash:'bad'},{schemaVersion:2}])assert.throws(()=>importRepairRequest({...wire(),...change}));
});
test('exact live model only; no retired model or stale snapshot fallback',()=>{
  assert.equal(importRepairModel({source:'live-sdk',items:[{model_id:MODEL}]}),MODEL);
  for(const metadata of [{source:'owner-verified-snapshot',items:[{model_id:MODEL}]},{source:'live-sdk',items:[{model_id:'doubao-seed-2-0-pro-260215'}]},{source:'live-sdk',items:[{model_id:MODEL},{model_id:'doubao-seed-2.1-turbo'}]}])assert.throws(()=>importRepairModel(metadata));
});
test('real owner directory evidence binds exact project, environment, timestamp, model and version',()=>{
  for(const environment of ['DEV','PROD']){
    const saved=catalogueEvidence.environments[environment];assert.equal(saved.httpStatus,200);
    assert.equal(createHash('sha256').update(saved.raw).digest('hex'),saved.responseSha256);
    const response=JSON.parse(saved.raw);assert.equal(response.code,0);
    const metadata={source:'owner-verified-snapshot',projectId:catalogueEvidence.projectId,environment,retrievedAt:binding.retrievedAt,items:response.data.model_info_list};
    assert.equal(importRepairModel(metadata),MODEL);
    for(const change of [{projectId:'other'},{environment:'STAGING'},{retrievedAt:'2026-10-01T07:46:35.782Z'}])assert.throws(()=>importRepairModel({...metadata,...change}));
    const wrong=structuredClone(metadata);wrong.items.find(item=>item.model_id===MODEL).model_version='unverified';assert.throws(()=>importRepairModel(wrong));
    const retired=structuredClone(metadata);retired.items.find(item=>item.model_id===MODEL).is_offline=true;assert.throws(()=>importRepairModel(retired));
  }
});
test('field evidence binds exact source ids, literal content and explicit answer provenance',()=>{
  assert.deepEqual(importRepairResult(repaired(),wire()),repaired());
  for(const mutate of [q=>q.stem='模型编造',q=>q.evidence[0].sourceId='other',q=>q.evidence[0].quote='不存在',q=>q.evidence.pop(),q=>q.answerOptionIds=['B'],q=>q.evidence.at(-1).quote='A. 蓝色',q=>q.questionType='multiple_choice',q=>q.sourceName='伪造来源']){
    const output=repaired();mutate(output.questions[0]);assert.throws(()=>importRepairResult(output,wire()));}
  assert.deepEqual(importRepairResult({status:'unresolved',diagnosis:'原答案缺失',questions:[]},wire()),{status:'unresolved',diagnosis:'原答案缺失',questions:[]});
});
test('one question cannot borrow another source answer/options or impersonate whole-group coverage',()=>{
  const request=wire();request.sources.push({id:'s2',text:request.sources[0].text});
  for(const field of ['answerOptionIds','options.A']){const output=repaired();output.questions[0].evidence.find(ref=>ref.field===field).sourceId='s2';assert.throws(()=>importRepairResult(output,request));}
  const both=repaired();both.questions[0].evidence.push({field:'stem',sourceId:'s2',quote:'天空颜色？'});assert.throws(()=>importRepairResult(both,request));
  const coverage=repaired();coverage.questions[0].evidence.push({field:'questionType',sourceId:'s2',quote:'单选题'});assert.throws(()=>importRepairResult(coverage,request));
  const full=repaired();const second=JSON.parse(JSON.stringify(full.questions[0]));second.evidence.forEach(ref=>ref.sourceId='s2');full.questions.push(second);assert.equal(importRepairResult(full,request).questions.length,2);
});
function tableFixture(){
  const request=wire();request.sources[0].text='题型\t题干\tA\tB\t备注\t答案\n单选题\t天空颜色？\t蓝色\t绿色\t\tA';
  const output=repaired();for(const ref of output.questions[0].evidence){if(ref.field==='options.A')ref.quote='蓝色';if(ref.field==='options.B')ref.quote='绿色';if(ref.field==='answerOptionIds')ref.quote='A';}
  return {request,output};
}
test('literal TSV header maps answer column including empty intervening cells',()=>{
  const {request,output}=tableFixture();assert.equal(importRepairResult(output,request).questions[0].answerOptionIds[0],'A');
  assert.equal(output.questions[0].evidence.at(-1).quote,'A');
});
test('TSV rejects shifted rows, ambiguous columns, wrong answers and duplicate matching rows',()=>{
  for(const mutate of [r=>r.sources[0].text=r.sources[0].text.replace('绿色\t\tA','绿色\tA'),r=>r.sources[0].text=r.sources[0].text.replace('备注','正确答案'),
    r=>r.sources[0].text+='\n单选题\t天空颜色？\t蓝色\t绿色\t\tB',r=>r.sources[0].text=r.sources[0].text.replace(/\tA$/u,'\t')]){
    const {request,output}=tableFixture();mutate(request);assert.throws(()=>importRepairResult(output,request));}
  const {request,output}=tableFixture();output.questions[0].answerOptionIds=['B'];output.questions[0].evidence.at(-1).quote='B';assert.throws(()=>importRepairResult(output,request));
});
test('TSV true/false and fill answers bind actual cells, not option or other-column text',()=>{
  const request=wire();request.sources[0].text='题型\t题干\t答案\n判断题\t天空颜色？\t错误';
  const output=repaired(),q=output.questions[0];Object.assign(q,{questionType:'true_false',options:[],answerOptionIds:[],answerBoolean:false});
  q.evidence=[{field:'stem',sourceId:'s1',quote:'天空颜色？'},{field:'questionType',sourceId:'s1',quote:'判断题'},{field:'answerBoolean',sourceId:'s1',quote:'错误'}];
  assert.equal(importRepairResult(output,request).questions[0].answerBoolean,false);
  request.sources[0].text='题型\t题干\t答案\n填空题\t天空颜色？\t蓝色';Object.assign(q,{questionType:'fill_blank',answerBoolean:null,answerText:'蓝色',answerParts:[{position:1,text:'蓝色'}],expectedBlankCount:1});
  q.evidence=[{field:'stem',sourceId:'s1',quote:'天空颜色？'},{field:'questionType',sourceId:'s1',quote:'填空题'},{field:'answerText',sourceId:'s1',quote:'蓝色'},{field:'answerParts.1',sourceId:'s1',quote:'蓝色'},{field:'expectedBlankCount',sourceId:'s1',quote:'填空题'}];
  assert.equal(importRepairResult(output,request).questions[0].answerText,'蓝色');
});
test('multi-choice answer sets are equal, never a proper subset or extra option',()=>{
  const request=wire(),output=repaired();request.sources[0].text=request.sources[0].text.replace('单选题','多选题').replace('答案：A','答案：AB');
  const q=output.questions[0];q.questionType='multiple_choice';q.evidence[0].quote='多选题';q.evidence.at(-1).quote='答案：AB';
  assert.throws(()=>importRepairResult(output,request)); // A is present but is not the complete AB answer.
  q.answerOptionIds=['B','A'];assert.equal(importRepairResult(output,request).questions[0].answerOptionIds.length,2);
  request.sources[0].text=request.sources[0].text.replace('答案：AB','答案：A');q.evidence.at(-1).quote='答案：A';assert.throws(()=>importRepairResult(output,request));
});
test('numeric option IDs 1-8 require the exact original numeric set, without letter conversion',()=>{
  const {request,output}=tableFixture();request.sources[0].text='题型\t题干\t1\t2\t答案\n多选题\t天空颜色？\t蓝色\t绿色\t1、2';
  const q=output.questions[0];q.questionType='multiple_choice';q.options[0].id='1';q.options[1].id='2';q.answerOptionIds=['1','2'];
  q.evidence[0].quote='多选题';q.evidence.find(r=>r.field==='options.A').field='options.1';q.evidence.find(r=>r.field==='options.B').field='options.2';q.evidence.at(-1).quote='1、2';
  assert.equal(importRepairResult(output,request).questions[0].answerOptionIds.length,2);
  q.answerOptionIds=['1'];assert.throws(()=>importRepairResult(output,request));
  q.answerOptionIds=['A','B'];assert.throws(()=>importRepairResult(output,request));
});
test('source_correct carrier requires full exact authored answer, not a contained substring',()=>{
  const request=wire(),output=repaired();request.sources[0].text='单选题\n天空颜色？\n答案：蓝色和绿色';
  const q=output.questions[0];q.options=[{id:'source_correct',text:'蓝色'}];q.answerOptionIds=['source_correct'];
  q.evidence=q.evidence.filter(r=>!r.field.startsWith('options.'));q.evidence.at(-1).quote='答案：蓝色和绿色';q.evidence.push({field:'options.source_correct',sourceId:'s1',quote:'蓝色和绿色'});
  assert.throws(()=>importRepairResult(output,request));q.options[0].text='蓝色和绿色';assert.equal(importRepairResult(output,request).questions[0].options[0].text,'蓝色和绿色');
});
test('durable same-key and new-key/same-content replay invokes once, never charges points',async t=>{
  const store=await database(t),provider=bridge(),jobs=importRepairJobs(store,provider);t.after(()=>jobs.close());
  const first=await jobs.create('one','key_a',wire());assert.equal(first.state,'completed');assert.deepEqual(first.usage,usage);
  assert.equal((await jobs.create('one','key_a',wire())).requestId,first.requestId);
  assert.equal((await jobs.create('one','key_b',wire())).requestId,first.requestId);
  assert.equal(provider.state.calls,1);assert.equal((await store.get('SELECT COUNT(*) n FROM points_ledger')).n,0);
  await assert.rejects(jobs.create('one','key_a',{...wire(),groupId:'different'}),e=>e.code==='IDEMPOTENCY_CONFLICT');
  await assert.rejects(jobs.get('two','key_a'),e=>e.code==='IMPORT_REPAIR_NOT_FOUND');
  const restarted=importRepairJobs(store,provider);assert.equal((await restarted.get('one','key_a')).state,'completed');restarted.close();
});
test('unknown provider outcome remains durable and never redispatches with a new key',async t=>{
  const store=await database(t),provider=bridge(async()=>{throw new Error('connection lost');}),jobs=importRepairJobs(store,provider);
  assert.equal((await jobs.create('one','lost',wire())).state,'unknown');
  assert.equal((await jobs.create('one','new-key',wire())).state,'unknown');assert.equal(provider.state.calls,1);jobs.close();
});
test('concurrent duplicate submissions share one durable in-flight job',async t=>{
  let release,started;const ready=new Promise(resolve=>started=resolve),store=await database(t);
  const provider=bridge(async()=>{started();return new Promise(resolve=>release=()=>resolve({result:repaired(),usage}));}),jobs=importRepairJobs(store,provider);
  const first=jobs.create('one','first',wire());await ready;
  const duplicate=await jobs.create('one','duplicate',wire());assert.equal(duplicate.state,'processing');assert.equal(provider.state.calls,1);
  release();assert.equal((await first).state,'completed');assert.equal((await jobs.get('one','duplicate')).state,'completed');jobs.close();
});
test('provider timeout stays unknown; late results do not overwrite or start another call',async t=>{
  let release;const store=await database(t),provider=bridge(async()=>new Promise(resolve=>release=resolve)),jobs=importRepairJobs(store,provider,{timeoutMs:20});
  // Keep event loop alive: production HTTP owns this lifetime; the job deadline itself is unrefed.
  const keeper=setTimeout(()=>{},200);t.after(()=>clearTimeout(keeper));
  const outcome=await jobs.create('one','timed',wire());assert.equal(outcome.state,'unknown');
  release({result:repaired(),usage});await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await jobs.get('one','timed')).state,'unknown');assert.equal((await jobs.create('one','again',wire())).state,'unknown');assert.equal(provider.state.calls,1);jobs.close();
});
test('restart reads expired in-flight receipt as unknown without redispatch',async t=>{
  const store=await database(t),provider=bridge(),jobs=importRepairJobs(store,provider);
  const first=await jobs.create('one','restart',wire());
  const rows=await store.all('SELECT * FROM confirmations');const job=rows.find(row=>row.idempotency_key.includes(':job:'));
  await store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify({...first,state:'processing',expiresAt:1,result:undefined}),'one',job.idempotency_key);
  const second=importRepairJobs(store,provider);assert.equal((await second.get('one','restart')).state,'unknown');assert.equal(provider.state.calls,1);jobs.close();second.close();
});
test('invalid completed JSON retains real usage but is never accepted as repaired',async t=>{
  const store=await database(t),provider=bridge(async()=>({usage,providerRequestId:'synthetic_invalid',result:null})),jobs=importRepairJobs(store,provider);
  const outcome=await jobs.create('one','invalid',wire());assert.equal(outcome.state,'unknown');assert.deepEqual(outcome.usage,usage);assert.equal(outcome.result,undefined);jobs.close();
});
test('missing live catalogue fails before submission and HTTP receipt requires auth',async t=>{
  const store=await database(t),provider=bridge();provider.metadata=async()=>({source:'owner-verified-snapshot',items:[{model_id:MODEL}]});
  const app=Fastify();t.after(()=>app.close());app.setErrorHandler((e,req,reply)=>reply.code(e.statusCode??500).send({error:{code:e.code}}));
  await importRepairRoutes(app,{store,cozeBridge:provider,auth:async req=>{if(req.headers.authorization!=='fixture')throw Object.assign(new Error('login'),{statusCode:401});req.auth={user_id:'one'};}});
  assert.equal((await app.inject({method:'GET',url:'/v1/ai/import-repair/receipt'})).statusCode,401);
  const headers={authorization:'fixture','idempotency-key':'http'};
  const response=await app.inject({method:'POST',url:'/v1/ai/import-repair',headers,payload:wire()});assert.equal(response.statusCode,200);assert.equal(response.json().error.code,'IMPORT_REPAIR_LIVE_CATALOG_REQUIRED');assert.equal(provider.state.calls,0);
  assert.equal((await app.inject({method:'GET',url:'/v1/ai/import-repair/receipt',headers})).json().state,'failed');
});
test('gateway sends exactly one non-tool request and refuses compatibility retries',async t=>{
  let calls=0,submitted=0;t.mock.method(globalThis,'fetch',async(_url,init)=>{calls++;const body=JSON.parse(init.body);assert.equal(body.stream,false);assert.equal(body.tools,undefined);assert.equal(body.response_format,undefined);return new Response('{}',{status:422});});
  await assert.rejects(cozeGatewayImportRepair({baseUrl:'https://synthetic.example/v1',key:'test-secret',headers:{}},MODEL,wire(),{signal:new AbortController().signal,onSubmitted:()=>submitted++}));
  assert.equal(calls,1);assert.equal(submitted,1);
});
