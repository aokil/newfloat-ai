import test from 'node:test';
import assert from 'node:assert/strict';
import {COZE_DOUBAO_21_TURBO_ID,searchModelConfig} from '../src/model-catalog.js';
import {testApp,register,call} from './helpers.js';

const legacy={
  execution:'coze',provider:'doubao',catalogKey:'doubao-pro',
  modelId:'doubao-seed-2-0-pro-260215',displayName:'Doubao-Seed-2.0-pro',
  baseUrl:null,enabled:true,capabilities:['text'],maxOutputTokens:2048,timeoutMs:30000,pointsPerCall:2
};
const turboName='Doubao-Seed-2.1-turbo';
const usage={prompt_tokens:5,completion_tokens:4,total_tokens:9};
const image={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xGQAAAAASUVORK5CYII='};

test('the saved Coze Pro slot uses Turbo for search and connection tests',async t=>{
  const checks=[],searches=[];
  const app=await testApp({cozeBridge:{
    ready:true,
    async metadata(){return {items:[{model_id:COZE_DOUBAO_21_TURBO_ID}]};},
    async test(config){checks.push(config.modelId);return {status:'passed',usage};},
    async search(config,question,options){searches.push({modelId:config.modelId,image:options.image});return {answer:'A',explanation:'',usage};}
  }});
  t.after(()=>app.close());
  const owner=await register(app,'synthetic-turbo-owner');
  const id='model_synthetic_legacy_doubao_pro';
  await app.store.run("INSERT INTO models(id,config,revision,created_at,last_test_status) VALUES(?,?,1,?,'passed')",id,JSON.stringify(legacy),Date.now());

  let response=await call(app,'GET','/v1/models/catalog',owner.accessToken);
  assert.equal(response.statusCode,200,response.body);
  const item=response.json().items.find(entry=>entry.key==='doubao-pro');
  assert.equal(item.name,turboName);
  assert.equal(item.available,true);
  assert.equal(item.supportsImages,true);
  assert.equal(item.pointsPerCall,2);

  const request={mode:'builtin',modelKey:'doubao-pro',question:'合成题目\nA. 甲\nB. 乙',image};
  response=await call(app,'POST','/v1/ai/search',owner.accessToken,request,'fixture-turbo-search');
  assert.equal(response.statusCode,200,response.body);
  const receipt=response.json();
  assert.equal(receipt.model.name,turboName);
  assert.equal(receipt.pointsCharged,2);
  response=await call(app,'POST','/v1/ai/search',owner.accessToken,request,'fixture-turbo-search');
  assert.deepEqual(response.json(),receipt);
  assert.deepEqual(searches,[{modelId:COZE_DOUBAO_21_TURBO_ID,image}]);

  await app.store.run("UPDATE users SET role='admin' WHERE id=?",owner.principal.userId);
  response=await call(app,'POST',`/v1/admin/models/${id}/test`,owner.accessToken,{expectedRevision:1},'fixture-turbo-test');
  assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().status,'passed',response.body);
  assert.deepEqual(checks,[COZE_DOUBAO_21_TURBO_ID]);
  assert.deepEqual(JSON.parse((await app.store.get('SELECT config FROM models WHERE id=?',id)).config),legacy);
});

test('the override is confined to the known legacy Coze binding',()=>{
  for(const changed of [
    {...legacy,execution:'official'},
    {...legacy,catalogKey:'doubao-lite'},
    {...legacy,modelId:'doubao-seed-2-1-pro-260915'},
    {...legacy,modelId:COZE_DOUBAO_21_TURBO_ID}
  ]) assert.equal(searchModelConfig(changed),changed);
});
