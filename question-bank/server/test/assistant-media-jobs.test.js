import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import Fastify from 'fastify';
import {assistantMediaJobs} from '../src/assistant-media-jobs.js';
import {assistantMediaRoutes} from '../src/assistant-media-routes.js';
import {assistantMediaDownload} from '../src/assistant-media-download.js';
import {mediaCreateRequest} from '../src/assistant-media-contract.js';
import {ApiError} from '../src/security.js';

// Source definitions only. Synthetic bridge metadata, no provider/phone/file generation calls.
function receipts(){
  const rows=new Map();const key=(owner,id)=>owner+'|'+id;
  return {
    async get(_sql,owner,id){const row=rows.get(key(owner,id));return row?{...row}:undefined;},
    async run(sql,...args){
      if(sql.startsWith('INSERT')){const [owner,id,hash,result]=args,k=key(owner,id);if(rows.has(k))return {changes:0};
        rows.set(k,{owner_id:owner,idempotency_key:id,request_hash:hash,result});return {changes:1};}
      if(sql.startsWith('UPDATE')){const [result,owner,id,expected]=args,row=rows.get(key(owner,id));
        if(!row||row.result!==expected)return {changes:0};rows.set(key(owner,id),{...row,result});return {changes:1};}
      if(sql.startsWith('DELETE'))return {changes:rows.delete(key(args[0],args[1]))?1:0};
      throw new Error('Unexpected synthetic SQL');
    }
  };
}
const IMAGE='doubao-seedream-5-0-260128',VIDEO='doubao-seedance-2-0-260128';
const catalogue={items:[{id:IMAGE,kind:'image',default:true,available:true},{id:VIDEO,kind:'video',default:true,available:true}]};
const imageFiles=[{url:'https://synthetic.tos-cn-beijing.volces.com/image.png',kind:'image',name:'合成元数据',mimeType:'image/png'}];
function wire(jobId='fixture_media_1',kind='image'){return {jobId,conversationId:'fixture_conversation',taskId:'fixture_task',kind,modelId:'',
  parameters:{prompt:'合成生成测试，不执行真实模型'},references:[],timeoutSeconds:5};}
async function eventually(check){for(let index=0;index<100;index++){if(await check())return;await turn();}assert.fail('Synthetic worker did not settle');}
function bridge(image){
  const calls=[];
  return {calls,ready:true,async media(operation,input,signal){
    calls.push({operation,input});if(operation==='models')return catalogue;
    if(operation==='generate_image')return image?image(signal):{files:imageFiles};
    if(operation==='generate_video')return {providerTaskId:'fixture_provider_video',status:'queued'};
    if(operation==='video_status')return {status:'succeeded',files:[{url:'https://synthetic.tos-cn-beijing.volces.com/video.mp4',kind:'video',name:'合成视频元数据',mimeType:'video/mp4'}]};
    throw new Error('No provider deletion/retry operation exists in this fixture');
  }};
}

test('durable idempotency dispatches one creation and never publishes provider URLs to the model',async t=>{
  const store=receipts(),provider=bridge(),jobs=assistantMediaJobs(store,provider);t.after(()=>jobs.close());
  await Promise.all([jobs.create('owner_a',wire()),jobs.create('owner_a',wire())]);
  await eventually(async()=>(await jobs.status('owner_a','fixture_media_1',new AbortController().signal)).status==='succeeded');
  const replay=await jobs.create('owner_a',wire());
  assert.equal(provider.calls.filter(call=>call.operation==='generate_image').length,1);
  assert.equal(replay.generated,true);assert.equal(JSON.stringify(replay).includes('https://'),false);
  await assert.rejects(jobs.create('owner_a',{...wire(),parameters:{prompt:'其他内容'}}),error=>error.code==='MEDIA_IDEMPOTENCY_CONFLICT');
});

test('stop-before-create tombstone prevents a late paid creation',async t=>{
  const provider=bridge(),jobs=assistantMediaJobs(receipts(),provider);t.after(()=>jobs.close());
  const stopped=await jobs.cancel('owner_a','fixture_late');assert.equal(stopped.cancelled,true);
  const late=await jobs.create('owner_a',wire('fixture_late'));
  assert.equal(late.status,'cancelled');assert.equal(provider.calls.filter(call=>call.operation.startsWith('generate_')).length,0);
});

test('submitted creation is retained after Stop; no destructive provider DELETE is used',async t=>{
  let finish;
  const provider=bridge(signal=>new Promise((resolve,reject)=>{
    finish=resolve;signal.addEventListener('abort',()=>reject(new ApiError(499,'SYNTHETIC_ABORT','合成取消')),{once:true});
  }));
  const jobs=assistantMediaJobs(receipts(),provider);t.after(()=>jobs.close());
  await jobs.create('owner_a',wire('fixture_submitted'));
  await eventually(()=>typeof finish==='function');
  const stopped=await jobs.cancel('owner_a','fixture_submitted');assert.equal(stopped.cancelled,false);
  finish({files:imageFiles});
  await eventually(async()=>(await jobs.status('owner_a','fixture_submitted',new AbortController().signal)).status==='succeeded');
  assert.equal(provider.calls.filter(call=>call.operation==='generate_image').length,1);
  assert.equal((await jobs.asset('owner_a','fixture_submitted',0)).url,imageFiles[0].url);
});

test('unknown submission never automatically repeats creation and remains distinct from success',async t=>{
  const provider=bridge(async()=>{throw new ApiError(502,'MEDIA_SUBMISSION_UNKNOWN','合成网络响应丢失');});
  const jobs=assistantMediaJobs(receipts(),provider);t.after(()=>jobs.close());
  await jobs.create('owner_a',wire('fixture_uncertain'));
  await eventually(async()=>(await jobs.status('owner_a','fixture_uncertain',new AbortController().signal)).status==='unknown');
  const retry=await jobs.create('owner_a',wire('fixture_uncertain'));
  assert.equal(retry.generated,false);assert.equal(retry.status,'unknown');
  assert.equal(provider.calls.filter(call=>call.operation==='generate_image').length,1);
});

test('owner isolation and restart recovery preserve video ids without recreating the task',async t=>{
  const store=receipts(),provider=bridge(),first=assistantMediaJobs(store,provider);t.after(()=>first.close());
  await first.create('owner_a',wire('fixture_video','video'));
  await eventually(()=>provider.calls.some(call=>call.operation==='generate_video'));
  await first.close();
  const restored=assistantMediaJobs(store,provider);t.after(()=>restored.close());
  await assert.rejects(restored.status('owner_b','fixture_video',new AbortController().signal),error=>error.code==='MEDIA_JOB_NOT_FOUND');
  const found=await restored.status('owner_a','fixture_video',new AbortController().signal);
  assert.equal(found.status,'succeeded');assert.equal(provider.calls.filter(call=>call.operation==='generate_video').length,1);
});

test('generation parameters and whole-reference SHA are validated without silently changing input',()=>{
  const source=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFioAAAAASUVORK5CYII=','base64');
  const input={...wire(),parameters:{prompt:'合成参数',size:'3K',count:2,watermark:false},references:[{file_id:'source_1',mimeType:'image/png',data:source.toString('base64')}]};
  const actual=mediaCreateRequest(input);
  assert.deepEqual(actual.parameters,input.parameters);assert.equal(actual.references[0].data,input.references[0].data);
  assert.throws(()=>mediaCreateRequest({...input,references:[{...input.references[0],sha256:'not_the_original_hash'}]}));
  assert.throws(()=>mediaCreateRequest({...input,parameters:{...input.parameters,apiUrl:'https://unapproved.example'}}));
});

test('non-admin bodies are rejected before parsing or dispatch; asset URLs cannot reach private/unapproved targets',async t=>{
  const app=Fastify({logger:false}),provider=bridge();
  app.setErrorHandler((error,_req,reply)=>reply.code(error.statusCode??500).send({error:{code:error.code}}));
  await assistantMediaRoutes(app,{store:receipts(),auth:async req=>{req.auth={role:'user',user_id:'owner_b'};},cozeBridge:provider});
  t.after(()=>app.close());
  const response=await app.inject({method:'POST',url:'/v1/assistant/media/jobs',headers:{'content-type':'application/json'},payload:'not_json'});
  assert.equal(response.statusCode,403);assert.equal(provider.calls.length,0);
  for(const url of ['http://127.0.0.1/private','https://localhost/private','https://volces.com.unapproved.example/key','file:///private']){
    await assert.rejects(assistantMediaDownload(url,new AbortController().signal),error=>error.code==='MEDIA_FILE_URL_INVALID');
  }
});
