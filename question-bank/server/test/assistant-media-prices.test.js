import test from 'node:test';
import assert from 'node:assert/strict';
import {mediaPricing,mediaEffectiveParameters,mediaQuote,mediaUsage,mediaCost} from '../src/assistant-media-prices.js';

// Synthetic counters only. No provider, account, filesystem output, or paid generation requests.
const LITE='doubao-seedream-5-0-260128',IMAGE45='doubao-seedream-4-5-251128';
const VIDEO15='doubao-seedance-1-5-pro-251215',VIDEO20='doubao-seedance-2-0-260128';
const pricing=id=>mediaPricing(id,id.includes('seedream')?'image':'video');
const params=(p,overrides={})=>mediaEffectiveParameters(p,overrides);
const fails=(fn,code)=>assert.throws(fn,error=>error.statusCode===422&&error.code===code);

test('only exact registered generation IDs have immutable price snapshots',()=>{
  const p=pricing(LITE);
  assert.equal(p.unit,'image');assert.equal(p.source,'coze_public');assert.equal(p.rates.image,'0.22');
  assert.ok(Object.isFrozen(p));assert.ok(Object.isFrozen(p.rates));
  for(const id of ['Seedream 5.0 Lite','doubao-seedream-5-0-lite-260128','__proto__'])fails(()=>mediaPricing(id,'image'),'MEDIA_PRICE_UNAVAILABLE');
  fails(()=>mediaPricing(VIDEO15,'image'),'MEDIA_PRICE_UNAVAILABLE');
});

test('classification multipliers and unit prices are display metadata, not another fee multiplier',()=>{
  assert.equal(pricing(LITE).displayMultiplier,'1×');assert.equal(pricing(IMAGE45).displayMultiplier,'1.14×');
  assert.equal(pricing(VIDEO15).displayMultiplier,'1×');assert.equal(pricing(VIDEO20).displayMultiplier,'3×');
  assert.match(pricing(VIDEO15).description,/有声1×、无声0\.5×/u);
  assert.match(pricing(VIDEO20).description,/有声3×、无声1\.5×/u);
  assert.equal(pricing(VIDEO20).source,'app_policy');assert.equal(pricing(VIDEO20).derivedMultiplier,3);
  assert.ok(!/用户指定|你指定|官方2\.0/u.test(pricing(VIDEO20).description));
  assert.equal(mediaCost(pricing(IMAGE45),{generatedImages:1},{}).nanos,7_000_000_000n);
});

test('image defaults are one 2K image and explicit parameters are preserved',()=>{
  const p=pricing(LITE),original={prompt:'synthetic',size:'3K',count:3,watermark:false};
  assert.deepEqual(params(p),{size:'2K',count:1});
  assert.deepEqual(params(p,original),original);assert.deepEqual(original,{prompt:'synthetic',size:'3K',count:3,watermark:false});
  assert.equal(mediaQuote(p,params(p)).amountNanos,'6160000000');
});

test('image maximum request count reserves exactly but actual count settles independently',()=>{
  const p=pricing(LITE),effective=params(p,{count:4}),q=mediaQuote(p,effective);
  assert.equal(q.amountNanos,'24640000000');assert.equal(q.units,2464);assert.equal(q.estimated,false);
  assert.equal(q.guaranteedUpperBound,true);assert.deepEqual(q.basis,{generatedImages:4});
  assert.equal(mediaCost(p,{generatedImages:2},effective).nanos,12_320_000_000n);
});

test('image size and count errors do not silently default or truncate',()=>{
  for(const value of [0,16,1.5,'2'])fails(()=>params(pricing(LITE),{count:value}),'MEDIA_REQUEST_INVALID');
  fails(()=>params(pricing(LITE),{size:'4K'}),'MEDIA_REQUEST_INVALID');
  fails(()=>params(pricing(IMAGE45),{size:'3K'}),'MEDIA_REQUEST_INVALID');
  fails(()=>params(pricing(LITE),{size:'8192x400'}),'MEDIA_REQUEST_INVALID');
  assert.equal(params(pricing(LITE),{size:'2048x2048'}).size,'2048x2048');
});

test('video defaults are explicit and neither model nor output budget changes',()=>{
  const p=pricing(VIDEO15),effective=params(p);
  assert.equal(effective.resolution,'720p');assert.equal(effective.ratio,'16:9');
  assert.equal(effective.duration,5);assert.equal(effective.generate_audio,true);
  assert.equal(effective.reference_mode,'reference_images');
  assert.equal(mediaQuote(p,effective).amountNanos,'48384000000');
});

test('actual model duration, resolution and audio parameters are validated',()=>{
  for(const value of [0,3,13,-1,5.5])fails(()=>params(pricing(VIDEO15),{duration:value}),'MEDIA_REQUEST_INVALID');
  assert.equal(params(pricing(VIDEO20),{duration:15}).duration,15);
  fails(()=>params(pricing(VIDEO20),{duration:16}),'MEDIA_REQUEST_INVALID');
  fails(()=>params(pricing(VIDEO15),{resolution:'4K'}),'MEDIA_REQUEST_INVALID');
  fails(()=>params(pricing(VIDEO15),{generate_audio:'false'}),'MEDIA_REQUEST_INVALID');
  assert.equal(params(pricing(VIDEO15),{generate_audio:false}).generate_audio,false);
});

test('reference images retain their actual first-frame or first-last-frame meaning',()=>{
  const p=pricing(VIDEO15);
  assert.equal(mediaEffectiveParameters(p,{},[{}]).reference_mode,'first_frame');
  assert.equal(mediaEffectiveParameters(p,{reference_mode:'first_last_frame'},[{},{}]).reference_mode,'first_last_frame');
  fails(()=>mediaEffectiveParameters(p,{},[{},{}]),'MEDIA_REQUEST_INVALID');
  fails(()=>mediaEffectiveParameters(p,{reference_mode:'first_last_frame'},[{}]),'MEDIA_REQUEST_INVALID');
  fails(()=>mediaEffectiveParameters(pricing(VIDEO20),{},Array(10).fill({})),'MEDIA_REQUEST_INVALID');
});

test('video quote is explicitly a non-guaranteed estimate and never actual receipt usage',()=>{
  const p=pricing(VIDEO15),effective=params(p),q=mediaQuote(p,effective);
  assert.equal(q.estimated,true);assert.equal(q.guaranteedUpperBound,false);
  assert.equal(q.basis.completionTokens,108000);assert.match(q.description,/不保证/u);
  assert.equal(mediaCost(p,{completionTokens:108900},effective).nanos,48_787_200_000n);
  assert.notEqual(q.amountNanos,String(mediaCost(p,{completionTokens:108900},effective).nanos));
});

test('adaptive quote uses known reference pixels without replacing the explicit ratio',()=>{
  const p=pricing(VIDEO15),effective=params(p,{ratio:'adaptive'}),q=mediaQuote(p,effective);
  assert.equal(effective.ratio,'adaptive');assert.equal(q.basis.adaptive,true);
  assert.equal(q.basis.width,1112);assert.equal(q.basis.height,834);
  assert.equal(q.guaranteedUpperBound,false);assert.match(q.description,/估算/u);
});

test('audio and silent actual token prices are exact and 2.0 is exactly triple both',()=>{
  const p15=pricing(VIDEO15),p20=pricing(VIDEO20);
  for(const [audio,base] of [[true,448_000_000n],[false,224_000_000n]]){
    assert.equal(mediaCost(p15,{completionTokens:1000},params(p15,{generate_audio:audio})).nanos,base);
    assert.equal(mediaCost(p20,{completionTokens:1000},params(p20,{generate_audio:audio})).nanos,base*3n);
  }
});

test('provider usage is normalized to a whitelist, preserving real zeros',()=>{
  assert.deepEqual(mediaUsage({usage:{generated_images:2,output_tokens:100,total_tokens:100},data:['private-url']},'image'),{generatedImages:2});
  assert.deepEqual(mediaUsage({usage:{completion_tokens:123,total_tokens:123},password:'hidden'},'video'),{completionTokens:123});
  assert.deepEqual(mediaUsage({total_tokens:123},'video'),{completionTokens:123});
  assert.deepEqual(mediaUsage({generated_images:0},'image'),{generatedImages:0});
  assert.deepEqual(mediaUsage({usage:{completion_tokens:0,total_tokens:0}},'video'),{completionTokens:0});
});

test('image billing uses confirmed image count without requiring unrelated token counters to match',()=>{
  const actual=mediaUsage({usage:{generated_images:2,output_tokens:100,total_tokens:123}},'image');
  assert.deepEqual(actual,{generatedImages:2});
  assert.equal(mediaCost(pricing(LITE),actual,params(pricing(LITE))).nanos,12_320_000_000n);
  fails(()=>mediaUsage({generatedImages:1,usage:{generated_images:2,output_tokens:100,total_tokens:123}},'image'),'MEDIA_USAGE_UNCONFIRMED');
});

test('missing or conflicting usage is unconfirmed, never inferred from files or requested duration',()=>{
  for(const raw of [{},{data:[{}]},{generated_images:-1},{generated_images:1.5},{generated_images:'1'},
    {generatedImages:1,usage:{generated_images:2}},{usage:null}])fails(()=>mediaUsage(raw,'image'),'MEDIA_USAGE_UNCONFIRMED');
  for(const raw of [{},{completion_tokens:-1},{completion_tokens:1,total_tokens:2},{completion_tokens:null,total_tokens:0},
    {completionTokens:0,usage:{completion_tokens:1}},{total_tokens:Number.MAX_SAFE_INTEGER+1}])fails(()=>mediaUsage(raw,'video'),'MEDIA_USAGE_UNCONFIRMED');
});

test('video total and output counters are alternatives and never summed',()=>{
  const p=pricing(VIDEO15),effective=params(p),usage=mediaUsage({usage:{total_tokens:1000,completion_tokens:1000}},'video');
  assert.equal(mediaCost(p,usage,effective).nanos,448_000_000n);
  assert.equal(mediaCost(p,{completionTokens:0},effective).nanos,0n);
  assert.equal(mediaCost(pricing(LITE),{generatedImages:0},{}).nanos,0n);
});

test('serialized trusted snapshots retain the pinned rates and tampering is refused',()=>{
  const p=pricing(VIDEO20),copy=JSON.parse(JSON.stringify(p));
  assert.equal(mediaCost(copy,{completionTokens:1000},params(copy)).nanos,1_344_000_000n);
  assert.equal(mediaCost({...copy,rates:{silent:'0.024',audio:'0.048'}},{completionTokens:1000},params(copy)).nanos,1_344_000_000n);
  fails(()=>params({...copy,version:'other'}),'MEDIA_PRICE_UNAVAILABLE');
  fails(()=>params({...copy,rates:{audio:'0',silent:'0'}}),'MEDIA_PRICE_UNAVAILABLE');
  fails(()=>mediaCost(copy,{completionTokens:1000},{}),'MEDIA_USAGE_UNCONFIRMED');
});
