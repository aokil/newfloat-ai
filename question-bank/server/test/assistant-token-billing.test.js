import test from 'node:test';
import assert from 'node:assert/strict';
import {AsyncSqliteStore} from '../src/async-store.js';
import {assistantTokenBilling} from '../src/assistant-token-billing.js';
import {assistantTokenPricing,assistantTokenUsage,assistantTokenCost,assistantTokenReservation,deepseekPricePeriod} from '../src/assistant-token-prices.js';

// Definitions for isolated in-memory accounts and provider counters; no real provider or account requests.
const OFF=Date.UTC(2026,10,4,12),PEAK=Date.UTC(2026,10,4,2);
const deepseek=(modelId='deepseek-flash',time=OFF)=>assistantTokenPricing({execution:'official',provider:'deepseek',modelId,baseUrl:'https://api.deepseek.com'},time);
const coze=id=>assistantTokenPricing({execution:'coze',provider:id.startsWith('glm')?'glm':'doubao',modelId:id},OFF);
const usage=(input=1000,output=1000,cached=0)=>({prompt_tokens:input,completion_tokens:output,total_tokens:input+output,prompt_cache_hit_tokens:cached,prompt_cache_miss_tokens:input-cached});
const quote=price=>assistantTokenReservation(price,{messages:[{role:'user',content:'synthetic-private-text'}],max_tokens:2048});
async function fixture(t,balance=100){
  const store=await AsyncSqliteStore.open(':memory:');t.after(()=>store.close());
  for(const [owner,role] of [['billing-user','user'],['billing-admin','admin']])
    await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES(?,?,?,?,?,?,?)',owner,owner,'合成账号','not-a-real-password',role,0,balance);
  const meter=assistantTokenBilling(store),price=deepseek();
  return {store,meter,price,begin:(id,owner='billing-user',reservation=quote(price),digest=id)=>meter.begin(owner,id,digest,price,reservation,5),
    user:(owner='billing-user')=>store.get('SELECT * FROM users WHERE id=?',owner),
    ledger:()=>store.all('SELECT * FROM points_ledger ORDER BY created_at,id')};
}

test('pricing matches exact execution and model IDs and hides unpriced families',()=>{
  assert.equal(assistantTokenPricing({execution:'coze',provider:'deepseek',modelId:'deepseek-flash'},OFF),null);
  assert.equal(assistantTokenPricing({execution:'coze',provider:'glm',modelId:'glm-5-0-260211'},OFF),null);
  assert.equal(assistantTokenPricing({execution:'official',provider:'deepseek',modelId:'DeepSeek V4.1 Flash',baseUrl:'https://api.deepseek.com'},OFF),null);
  assert.equal(assistantTokenPricing({execution:'coze',provider:'baichuan',modelId:'Baichuan4-Air'},OFF),null);
  assert(coze('glm-4-7-251222'));assert(deepseek());
});

test('the same real token counts cost different amounts for different confirmed models',()=>{
  const counter=assistantTokenUsage(usage());
  assert.equal(assistantTokenCost(coze('doubao-seed-2-0-mini-260215'),counter).nanos,61600000n);
  assert.equal(assistantTokenCost(coze('doubao-seed-2-0-pro-260215'),counter).nanos,537600000n);
  assert.equal(assistantTokenCost(deepseek(),counter).nanos,140000000n);
});

test('cache hits are priced separately and are not charged as cache misses',()=>{
  const result=assistantTokenCost(coze('doubao-seed-2-0-pro-260215'),assistantTokenUsage(usage(1000,200,500)));
  assert.equal(result.nanos,143360000n);
});

test('Coze input tiers and the GLM 200-output-token offer use the real final counts',()=>{
  assert.equal(assistantTokenCost(coze('doubao-seed-2-0-pro-260215'),assistantTokenUsage(usage(32000,1))).rates.input,'3.2');
  assert.equal(assistantTokenCost(coze('doubao-seed-2-0-pro-260215'),assistantTokenUsage(usage(32001,1))).rates.input,'4.8');
  const glm=coze('glm-4-7-251222');
  assert.equal(assistantTokenCost(glm,assistantTokenUsage(usage(1000,200))).nanos,100800000n);
  assert.equal(assistantTokenCost(glm,assistantTokenUsage(usage(1000,201))).nanos,162792000n);
});

test('DeepSeek uses Shanghai peak periods, weekends, holidays and the actual model rate',()=>{
  assert.equal(deepseekPricePeriod(PEAK),'peak');assert.equal(deepseekPricePeriod(OFF),'off_peak');
  assert.equal(deepseekPricePeriod(Date.UTC(2026,10,7,2)),'off_peak');
  assert.equal(deepseekPricePeriod(Date.UTC(2026,9,1,2)),'off_peak');
  assert.equal(deepseek('deepseek-flash',PEAK).tiers[0].output,'8');
  assert.equal(deepseek('deepseek-v4-pro',OFF).tiers[0].output,'13.5');
});

test('usage accepts zero output but rejects invented, missing or contradictory cache counters',()=>{
  assert.equal(assistantTokenUsage(usage(10,0)).total_tokens,10);
  assert.throws(()=>assistantTokenUsage({prompt_tokens:10,completion_tokens:2,total_tokens:12}),/缓存/u);
  assert.throws(()=>assistantTokenUsage({...usage(),total_tokens:10}));
  assert.throws(()=>assistantTokenUsage({...usage(),prompt_tokens_details:{cached_tokens:3}}));
});

test('budget quotes preserve overrides and provider defaults without mutating the request',()=>{
  const body={messages:[{role:'user',content:'only synthetic text'}],thinking:{type:'enabled'}};
  assert.equal(assistantTokenReservation(deepseek(),body).outputTokenBudget,65536);
  assert.equal(body.max_tokens,undefined);
  assert.equal(assistantTokenReservation(deepseek(),{...body,max_tokens:8192}).outputTokenBudget,8192);
  assert.equal(assistantTokenReservation(coze('glm-4-7-251222'),body).budgetSource,'provider_default_context_ceiling');
});

test('reasoning tokens are a completion component and never added to the output twice',()=>{
  const raw={...usage(),completion_tokens_details:{reasoning_tokens:800}};
  assert.equal(assistantTokenCost(deepseek(),assistantTokenUsage(raw)).nanos,140000000n);
});

test('eight sub-centipoint requests accumulate into one exact centipoint charge',async t=>{
  const f=await fixture(t,10);let bill;
  for(let index=0;index<8;index++){
    const run=await f.begin('fraction-'+index);await run.captureUsage(usage(10,10));bill=await run.finish();
    if(index<7)assert.equal(bill.pointsCharged,0);
  }
  assert.equal((await f.user()).points_balance,9.99);assert.equal(bill.carryNanoPoints,'1200000');
  assert.equal((await f.ledger()).length,1);
});

test('finishing the same request repeatedly cannot charge it twice',async t=>{
  const f=await fixture(t),run=await f.begin('finish-once');await run.captureUsage(usage());
  const first=await run.finish(),second=await run.finish();
  assert.equal(first.pointsCharged,0.14);assert.equal(second.pointsCharged,0.14);
  assert.equal((await f.user()).points_balance,99.86);assert.equal((await f.ledger()).length,1);
});

test('replayed request IDs are durable and a changed digest is rejected',async t=>{
  const f=await fixture(t),run=await f.begin('replay');await run.captureUsage(usage());await run.finish();
  await assert.rejects(f.begin('replay'),error=>error.code==='ASSISTANT_REQUEST_RECORDED');
  await assert.rejects(f.begin('replay','billing-user',quote(f.price),'changed'),error=>error.code==='ASSISTANT_IDEMPOTENCY_CONFLICT');
  assert.equal((await f.ledger()).length,1);
});

test('a stopped or invalid-result request still settles already received real usage',async t=>{
  const f=await fixture(t),run=await f.begin('stopped-after-usage');await run.captureUsage(usage());
  assert.equal((await run.finish()).pointsCharged,0.14);assert.equal((await f.user()).points_reserved,0);
});

test('missing usage releases the reservation and preserves the account fractional remainder',async t=>{
  const f=await fixture(t),small=await f.begin('known-small');await small.captureUsage(usage(10,10));const before=await small.finish();
  const run=await f.begin('no-usage'),bill=await run.finish();
  assert.equal(bill.state,'usage_unconfirmed');assert.equal(bill.pointsCharged,0);
  assert.equal(bill.carryNanoPoints,before.carryNanoPoints);assert.equal((await f.user()).points_reserved,0);
});

test('contradictory final usage is not guessed into a charge',async t=>{
  const f=await fixture(t),run=await f.begin('conflicting-usage');
  await run.captureUsage(usage());await run.captureUsage(usage(2000,1000));
  assert.equal((await run.finish()).state,'usage_unconfirmed');assert.equal((await f.user()).points_balance,100);
});

test('insufficient points reject a request before a reservation or provider dispatch exists',async t=>{
  const f=await fixture(t,0.01);
  await assert.rejects(f.begin('insufficient'),error=>error.code==='ASSISTANT_POINTS_REQUIRED');
  assert.equal((await f.user()).points_reserved,0);assert.equal((await f.ledger()).length,0);
});

test('concurrent reservations cannot spend the same available balance',async t=>{
  const f=await fixture(t,0.04),reservation={amountNanos:'25000000',units:3,outputTokenBudget:1,budgetSource:'override'};
  const values=await Promise.allSettled([f.begin('concurrent-a','billing-user',reservation),f.begin('concurrent-b','billing-user',reservation)]);
  assert.equal(values.filter(value=>value.status==='fulfilled').length,1);
  assert.equal((await f.user()).points_reserved,0.03);
});

test('restart recovery settles persisted usage and releases expired requests with unknown usage',async t=>{
  const f=await fixture(t),known=await f.begin('recover-known');await known.captureUsage(usage());await f.begin('recover-unknown');
  for(const row of await f.store.all('SELECT * FROM confirmations WHERE owner_id=?','billing-user')){
    const value=JSON.parse(row.result);if(value.type!=='assistant_token_v1')continue;value.expiresAt=0;
    await f.store.run('UPDATE confirmations SET result=? WHERE owner_id=? AND idempotency_key=?',JSON.stringify(value),row.owner_id,row.idempotency_key);
  }
  await assistantTokenBilling(f.store).recoverExpired();
  assert.equal((await f.user()).points_reserved,0);assert.equal((await f.user()).points_balance,99.86);
  assert.equal((await f.ledger()).length,1);
});

test('durable records contain financial counters and hashes without prompts or credentials',async t=>{
  const f=await fixture(t),run=await f.begin('financial-only');await run.captureUsage(usage());await run.finish();
  const records=await f.store.all('SELECT * FROM confirmations'),encoded=JSON.stringify(records);
  assert(records.every(row=>row.idempotency_key.length>128));
  assert(!encoded.includes('synthetic-private-text'));assert(!encoded.includes('apiKey'));assert(!encoded.includes('messages'));
});

test('an unexpected upstream over-budget counter never overdraws and settles once after top-up',async t=>{
  const f=await fixture(t,0.01),run=await f.begin('over-budget','billing-user',{amountNanos:'1000',units:1,outputTokenBudget:1,budgetSource:'override'});
  await run.captureUsage(usage());assert.equal((await run.finish()).state,'settlement_pending');
  assert.equal((await f.user()).points_balance,0.01);assert.equal((await f.user()).points_reserved,0);
  await f.store.run('UPDATE users SET points_balance=2 WHERE id=?','billing-user');
  await f.meter.recover('billing-user');await f.meter.recover('billing-user');
  assert.equal((await f.user()).points_balance,1.86);assert.equal((await f.ledger()).length,1);
});

test('administrator and ordinary accounts use the same rates with isolated fractional remainders',async t=>{
  const f=await fixture(t);
  for(const owner of ['billing-user','billing-admin']){
    const run=await f.begin('same-price',owner);await run.captureUsage(usage());assert.equal((await run.finish()).pointsCharged,0.14);
    assert.equal((await f.user(owner)).points_balance,99.86);
  }
  assert.equal((await f.ledger()).length,2);
});
