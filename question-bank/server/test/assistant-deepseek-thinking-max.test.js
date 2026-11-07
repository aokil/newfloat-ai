import test from 'node:test';
import assert from 'node:assert/strict';
import {assistantThinkingProfile,assistantThinkingRequest,applyAssistantThinking} from '../src/assistant-thinking.js';
import {assistantProviderBody} from '../src/assistant-model-transport.js';
import {assistantTokenPricing,assistantTokenReservation} from '../src/assistant-token-prices.js';

// Pure request/profile/quote definitions only; no network, user account or database is involved.
const config={execution:'official',provider:'deepseek',modelId:'deepseek-flash',baseUrl:'https://api.deepseek.com'};
const request=(mode='enabled',effort='max',maxOutputTokens=0)=>({protocolVersion:2,thinking:{mode,effort},maxOutputTokens,
  expectedModelId:'deepseek-flash',timeoutSeconds:45,messages:[{role:'user',content:'synthetic task'}],tools:[]});

test('only the two verified DeepSeek IDs gain the official max effort',()=>{
  for(const modelId of ['deepseek-flash','deepseek-v4-pro']){
    const profile=assistantThinkingProfile({...config,modelId});
    assert.deepEqual(profile.efforts,['provider_default','low','high','max']);assert.equal(profile.defaultEffort,'high');
  }
  for(const binding of [{provider:'deepseek',modelId:'DeepSeek V4.1 Flash'},{provider:'deepseek',modelId:'unknown'},
    {provider:'glm',modelId:'glm-5.3'},{provider:'doubao',modelId:'doubao-seed-evolving'}])
    assert(!assistantThinkingProfile(binding).efforts.includes('max'));
});

test('the request whitelist accepts max while rejecting unsupported aliases',()=>{
  assert.equal(assistantThinkingRequest(request()).thinking.effort,'max');
  assert.throws(()=>assistantThinkingRequest(request('enabled','medium')),error=>error.code==='ASSISTANT_THINKING_INVALID');
});

test('the real provider-body path sends enabled and max without a fixed output override',()=>{
  const actual=assistantProviderBody(config,request(),true);
  assert.deepEqual(actual.body.thinking,{type:'enabled'});assert.equal(actual.body.reasoning_effort,'max');
  assert.equal(actual.body.max_tokens,undefined);assert.equal(actual.configuration.effective_effort,'max');
});

test('max explicitly enables thinking even when the selected mode is provider_default',()=>{
  const body={};applyAssistantThinking(config,request('provider_default'),body);
  assert.deepEqual(body.thinking,{type:'enabled'});assert.equal(body.reasoning_effort,'max');
});

test('off clears inherited effort and leaves no reasoning_effort in the HTTP body',()=>{
  const body={reasoning_effort:'max'};applyAssistantThinking(config,request('disabled','provider_default'),body);
  assert.deepEqual(body.thinking,{type:'disabled'});assert.equal(body.reasoning_effort,undefined);
});

test('other actual profiles reject max after the shared request parser accepts it',()=>{
  const parsed=assistantThinkingRequest({thinking:{mode:'enabled',effort:'max'}});
  assert.throws(()=>applyAssistantThinking({provider:'glm',modelId:'glm-5.3'},parsed,{}),error=>error.code==='THINKING_CONFIGURATION_UNSUPPORTED');
});

test('an explicit budget is preserved and raw reasoning/tool history is untouched',()=>{
  const value=request('enabled','max',16384),history={role:'assistant',content:null,reasoning_content:'synthetic original reasoning'};
  value.messages.push(history);
  const actual=assistantProviderBody(config,value,true);
  assert.equal(actual.body.max_tokens,16384);assert.equal(actual.body.messages[1],history);
  assert.equal(actual.body.messages[1].reasoning_content,'synthetic original reasoning');
});

test('the balance quote uses 128K for max, 64K for ordinary thinking, 8K for off, and keeps overrides',()=>{
  const price=assistantTokenPricing(config,Date.UTC(2026,10,8,12));
  const quote=value=>assistantTokenReservation(price,assistantProviderBody(config,value,true).body).outputTokenBudget;
  assert.equal(quote(request()),131072);assert.equal(quote(request('enabled','high')),65536);
  assert.equal(quote(request('disabled','provider_default')),8192);assert.equal(quote(request('enabled','max',16384)),16384);
});
