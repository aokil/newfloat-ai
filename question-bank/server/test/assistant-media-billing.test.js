import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as turn} from 'node:timers/promises';
import Fastify from 'fastify';
import {AsyncSqliteStore} from '../src/async-store.js';
import {assistantMediaBilling} from '../src/assistant-media-billing.js';
import {assistantMediaJobs} from '../src/assistant-media-jobs.js';
import {assistantMediaRoutes} from '../src/assistant-media-routes.js';
import {mediaPricing,mediaQuote,mediaEffectiveParameters} from '../src/assistant-media-prices.js';
import {assistantTokenBilling} from '../src/assistant-token-billing.js';
import {assistantTokenPricing} from '../src/assistant-token-prices.js';
import {ApiError} from '../src/security.js';

// In-memory synthetic accounts/metadata only; no platform or real charge requests.
const IMAGE='doubao-seedream-5-0-260128',VIDEO='doubao-seedance-1-5-pro-251215',OWNER='media-admin';
const sourceFile={url:'https://synthetic.tos-cn-beijing.volces.com/result.png',kind:'image',mimeType:'image/png',name:'合成结果'};
const request=(id,kind='image')=>({jobId:id,conversationId:'synthetic-conversation',taskId:'synthetic-task',kind,
  modelId:kind==='image'?IMAGE:VIDEO,priceVersion:'assistant-media-cny-2026-11-06',parameters:{prompt:'synthetic-private-prompt'},references:[],timeoutSeconds:5});
const tokenPrice=()=>assistantTokenPricing({execution:'official',provider:'deepseek',modelId:'deepseek-flash',baseUrl:'https://api.deepseek.com'},Date.UTC(2026,10,4,12));
async function fixture(t,balance=200){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());
  await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES(?,?,?,?,?,?,?)',OWNER,OWNER,'合成账号','not-a-real-password','admin',0,balance);
  const meter=assistantMediaBilling(store);
  return {store,meter,user:()=>store.get('SELECT * FROM users WHERE id=?',OWNER),ledger:()=>store.all('SELECT * FROM points_ledger'),
    begin:(id,model=IMAGE,params={},quote)=>{
      const price=mediaPricing(model,model===IMAGE?'image':'video'),effective=mediaEffectiveParameters(price,{prompt:'synthetic-private-prompt',...params});
      return meter.begin(OWNER,id,id,price,quote??mediaQuote(price,effective),effective);
    }};
}
async function until(check){for(let i=0;i<150;i++){if(await check())return;await turn();}assert.fail('Synthetic media operation did not settle');}
function provider(generate){
  const calls=[];
  return {ready:true,calls,async media(operation,input){
    calls.push(operation);
    if(operation==='models')return {items:[{id:IMAGE,kind:'image',default:true,available:true},{id:VIDEO,kind:'video',default:true,available:true}]};
    if(operation==='generate_image')return generate?generate():{status:'succeeded',files:[sourceFile],usage:{generated_images:1}};
    if(operation==='generate_video')return {providerTaskId:'synthetic-provider-id',status:'queued'};
    if(operation==='video_status')return {status:'succeeded',usage:{completion_tokens:108900,total_tokens:108900},
      files:[{...sourceFile,url:sourceFile.url.replace('.png','.mp4'),kind:'video',mimeType:'video/mp4'}],providerMetadata:{model:VIDEO,generate_audio:true}};
    throw new Error('Unexpected synthetic operation');
  }};
}

test('a real image count settles the exact tariff and releases its reservation',async t=>{
  const f=await fixture(t);await f.begin('one-image');
  assert.equal((await f.user()).points_reserved,6.16);
  const bill=await f.meter.capture(OWNER,'one-image',{usage:{generated_images:1}},'succeeded');
  assert.equal(bill.state,'settled');assert.equal(bill.pointsCharged,6.16);
  assert.equal((await f.user()).points_balance,193.84);assert.equal((await f.user()).points_reserved,0);
});
test('partial image generation charges real generated_images, not requested or downloaded count',async t=>{
  const f=await fixture(t);await f.begin('partial',IMAGE,{count:3});
  const bill=await f.meter.capture(OWNER,'partial',{usage:{generated_images:2}},'failed');
  assert.equal(bill.pointsCharged,12.32);assert.equal(bill.state,'settled');
});
test('idempotent final receipts do not debit twice',async t=>{
  const f=await fixture(t);await f.begin('once');
  await f.meter.capture(OWNER,'once',{usage:{generated_images:1}},'succeeded');
  await f.meter.capture(OWNER,'once',{usage:{generated_images:1}},'succeeded');
  await f.meter.readReceipt(OWNER,'once');assert.equal((await f.ledger()).length,1);
});
test('missing final usage remains unconfirmed with its hold, not a guessed zero cost',async t=>{
  const f=await fixture(t);await f.begin('missing');
  const bill=await f.meter.capture(OWNER,'missing',{},'succeeded');
  assert.equal(bill.state,'usage_unconfirmed');assert.equal(bill.feeNanoPoints,null);
  assert.equal(bill.pointsReserved,6.16);assert.equal((await f.user()).points_balance,200);
});
test('a later valid receipt settles an unconfirmed job once after restart',async t=>{
  const f=await fixture(t);await f.begin('late');await f.meter.capture(OWNER,'late',{},'succeeded');
  const restored=assistantMediaBilling(f.store);
  assert.equal((await restored.capture(OWNER,'late',{usage:{generated_images:1}},'succeeded')).pointsCharged,6.16);
  assert.equal((await restored.readReceipt(OWNER,'late')).pointsCharged,6.16);assert.equal((await f.ledger()).length,1);
});
test('a real zero counter is distinct from missing usage',async t=>{
  const f=await fixture(t);await f.begin('zero');const bill=await f.meter.capture(OWNER,'zero',{usage:{generated_images:0}},'failed');
  assert.equal(bill.state,'settled');assert.equal(bill.feeNanoPoints,'0');assert.equal(bill.pointsReserved,0);assert.equal((await f.ledger()).length,0);
});
test('video total and completion counters are alternatives, never added',async t=>{
  const f=await fixture(t);await f.begin('video',VIDEO);
  const bill=await f.meter.capture(OWNER,'video',{usage:{completion_tokens:108900,total_tokens:108900}},'succeeded');
  assert.equal(bill.pointsCharged,48.78);assert.equal(bill.feeNanoPoints,'48787200000');assert.equal(bill.carryNanoPoints,'7200000');
});
test('the final factual audio setting selects the correct charge tier',async t=>{
  const f=await fixture(t);await f.begin('silent',VIDEO);
  const bill=await f.meter.capture(OWNER,'silent',{usage:{completion_tokens:1000},providerMetadata:{generate_audio:false,model:VIDEO}},'succeeded');
  assert.equal(bill.feeNanoPoints,'224000000');assert.equal(bill.pointsCharged,0.22);
});
test('model mismatch or contradictory counters cannot be priced as valid usage',async t=>{
  const f=await fixture(t);await f.begin('mismatch');
  assert.equal((await f.meter.capture(OWNER,'mismatch',{usage:{generated_images:1},providerMetadata:{model:'different-model'}},'succeeded')).state,'usage_unconfirmed');
  await f.begin('conflict',VIDEO);
  assert.equal((await f.meter.capture(OWNER,'conflict',{usage:{completion_tokens:10,total_tokens:11}},'succeeded')).state,'usage_unconfirmed');
  assert.equal((await f.ledger()).length,0);
});
test('language and media share a single account fractional remainder',async t=>{
  const f=await fixture(t);await f.begin('fraction',VIDEO);
  assert.equal((await f.meter.capture(OWNER,'fraction',{usage:{completion_tokens:20}},'succeeded')).pointsCharged,0);
  const language=await assistantTokenBilling(f.store).begin(OWNER,'language-fraction','digest',tokenPrice(),{amountNanos:'1000'},5);
  await language.captureUsage({prompt_tokens:10,completion_tokens:10,total_tokens:20,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:10});
  const bill=await language.finish();assert.equal(bill.pointsCharged,0.01);assert.equal(bill.carryNanoPoints,'360000');
});
test('insufficient balance rejects before reservation or provider submission',async t=>{
  const f=await fixture(t,1);
  await assert.rejects(f.begin('no-budget'),error=>error.code==='ASSISTANT_POINTS_REQUIRED');
  assert.equal((await f.user()).points_reserved,0);assert.equal((await f.ledger()).length,0);
});
test('underestimated video holds funds and blocks new language calls until top-up settles',async t=>{
  const f=await fixture(t,1);await f.begin('over',VIDEO,{}, {amountNanos:'10000000',units:1,estimated:true});
  const bill=await f.meter.capture(OWNER,'over',{usage:{completion_tokens:5000}},'succeeded');
  assert.equal(bill.state,'settlement_pending');assert.equal(bill.requiredPoints,1.24);assert.equal((await f.user()).points_balance,1);
  await assert.rejects(assistantTokenBilling(f.store).begin(OWNER,'blocked','digest',tokenPrice(),{amountNanos:'1000'},5),error=>error.code==='ASSISTANT_POINTS_REQUIRED');
  await f.store.run('UPDATE users SET points_balance=? WHERE id=?',3,OWNER);
  await f.meter.recover(OWNER);await f.meter.recover(OWNER);
  assert.equal((await f.user()).points_balance,0.76);assert.equal((await f.user()).points_reserved,0);assert.equal((await f.ledger()).length,1);
});
test('a pre-submission cancellation releases the hold; an attempted submission keeps it',async t=>{
  const f=await fixture(t);await f.begin('before');
  assert.equal((await f.meter.cancelBeforeSubmission(OWNER,'before')).state,'cancelled');
  await f.begin('after');await f.meter.markAttempted(OWNER,'after');
  assert.equal((await f.meter.cancelBeforeSubmission(OWNER,'after')).state,'pending');assert.equal((await f.user()).points_reserved,6.16);
});
test('financial records persist only safe numeric parameters, not prompts, images or URLs',async t=>{
  const f=await fixture(t);await f.begin('private');
  const text=JSON.stringify(await f.store.all('SELECT * FROM confirmations'));
  assert(!text.includes('synthetic-private-prompt'));assert(!text.includes('data:image'));assert(!text.includes(sourceFile.url));
});
test('file-delivery failure does not erase actual generation fees',async t=>{
  const f=await fixture(t),p=provider(()=>({status:'failed',files:[],usage:{generated_images:1},errorCode:'MEDIA_RESULT_INVALID',message:'合成链接失效'}));
  const jobs=assistantMediaJobs(f.store,p);t.after(()=>jobs.close());
  await jobs.create(OWNER,request('delivery-failure'));
  await until(async()=>(await jobs.status(OWNER,'delivery-failure')).status==='failed');
  const job=await jobs.status(OWNER,'delivery-failure');assert.equal(job.billing.pointsCharged,6.16);assert.equal(job.files.length,0);
});
test('deleting display history cannot erase a submitted video financial job or duplicate it',async t=>{
  const f=await fixture(t),p=provider(),jobs=assistantMediaJobs(f.store,p);t.after(()=>jobs.close());
  await jobs.create(OWNER,request('deleted-video','video'));
  await until(async()=>(await f.meter.pendingJobs()).some(row=>row.providerTaskId));
  await jobs.forget(OWNER,'deleted-video');await jobs.reconcile();
  const bill=await f.meter.readReceipt(OWNER,'deleted-video');assert.equal(bill.state,'settled');assert.equal(bill.pointsCharged,48.78);
  await assert.rejects(jobs.create(OWNER,request('deleted-video','video')),error=>error.code==='MEDIA_JOB_RECORDED');
  assert.equal(p.calls.filter(item=>item==='generate_video').length,1);
});
test('old free jobs are not retroactively charged when queried',async t=>{
  const f=await fixture(t),p=provider();
  const value={type:'assistant_media_v1',jobId:'legacy',conversationId:'c',taskId:'t',kind:'image',modelId:IMAGE,status:'succeeded',outputs:[sourceFile],createdAt:0,updatedAt:0};
  await f.store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',OWNER,'assistant_media_v1:legacy','legacy',JSON.stringify(value));
  const jobs=assistantMediaJobs(f.store,p);t.after(()=>jobs.close());
  assert.equal((await jobs.status(OWNER,'legacy')).billing.state,'legacy_free');assert.equal((await f.ledger()).length,0);
});
test('old clients are rejected before media generation and the new catalogue advertises real tariffs',async t=>{
  const f=await fixture(t),p=provider(),app=Fastify({logger:false});t.after(()=>app.close());
  app.setErrorHandler((error,_req,reply)=>reply.code(error.statusCode??500).send({error:{code:error.code}}));
  await assistantMediaRoutes(app,{store:f.store,cozeBridge:p,auth:async req=>{req.auth={role:'admin',user_id:OWNER};}});
  const response=await app.inject({method:'POST',url:'/v1/assistant/media/jobs',payload:request('old-client')});
  assert.equal(response.statusCode,426);assert.equal(p.calls.length,0);
  const catalogue=await app.inject({method:'GET',url:'/v1/assistant/media/models'});
  assert.equal(catalogue.json().items[0].billing.displayMultiplier,'1×');assert.equal(catalogue.json().billing.requiresClientHeader,'usage-v1');
});
test('a running video zero counter is not mistaken for a final free generation',async t=>{
  const f=await fixture(t);await f.begin('provisional',VIDEO);await f.meter.markAttempted(OWNER,'provisional');
  const pending=await f.meter.capture(OWNER,'provisional',{usage:{completion_tokens:0},providerMetadata:{id:'recoverable-id',status:'running'}});
  assert.equal(pending.state,'pending');assert(pending.pointsReserved>0);assert.equal(pending.feeNanoPoints,null);
  assert.equal((await f.meter.pendingJobs())[0].providerTaskId,'recoverable-id');
  const final=await f.meter.capture(OWNER,'provisional',{usage:{completion_tokens:1000},providerMetadata:{id:'recoverable-id',status:'succeeded'}});
  assert.equal(final.state,'settled');assert.equal(final.feeNanoPoints,'448000000');
});
test('an explicit provider rejection with only model metadata releases its hold',async t=>{
  const f=await fixture(t),p=provider(()=>{throw new ApiError(400,'MEDIA_PROVIDER_REJECTED','合成参数拒绝',{mediaEvidence:{providerMetadata:{model:IMAGE}}});});
  const jobs=assistantMediaJobs(f.store,p);t.after(()=>jobs.close());await jobs.create(OWNER,request('rejected'));
  await until(async()=>(await jobs.status(OWNER,'rejected')).status==='failed');
  assert.equal((await f.meter.readReceipt(OWNER,'rejected')).state,'cancelled');assert.equal((await f.user()).points_reserved,0);
});
test('an exceptional video create preserves its real task ID for background final accounting',async t=>{
  const f=await fixture(t),p=provider(),original=p.media.bind(p);
  p.media=async(operation,input)=>{
    if(operation==='generate_video')throw new ApiError(502,'MEDIA_RESULT_INVALID','合成状态字段异常',
      {mediaEvidence:{usage:{completion_tokens:0},providerMetadata:{id:'synthetic-provider-id',status:'running'}}});
    return original(operation,input);
  };
  const jobs=assistantMediaJobs(f.store,p);t.after(()=>jobs.close());await jobs.create(OWNER,request('exceptional-video','video'));
  await until(async()=>(await f.meter.pendingJobs()).some(row=>row.providerTaskId));
  await jobs.reconcile();assert.equal((await f.meter.readReceipt(OWNER,'exceptional-video')).state,'settled');
  assert.equal((await f.meter.readReceipt(OWNER,'exceptional-video')).pointsCharged,48.78);
  const retained=await f.store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',OWNER,'assistant_media_v1:exceptional-video');
  assert.equal(JSON.parse(retained.result).providerTaskId,'synthetic-provider-id');
});
