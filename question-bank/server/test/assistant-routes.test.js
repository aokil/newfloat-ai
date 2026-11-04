import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import {request as httpRequest} from 'node:http';
import {assistantRoutes} from '../src/assistant-routes.js';
import {ApiError,sha256} from '../src/security.js';
import {AsyncSqliteStore} from '../src/async-store.js';

const secret='isolated-assistant-route-secret';
const payload=(requestId='route_chat_1',message='解释一下矩阵')=>({modelKey:'deepseek-flash',mode:'chat',requestId,
  timeoutSeconds:5,visionEnabled:false,messages:[{role:'user',content:[{type:'text',text:JSON.stringify({message,conversation:[]})}]}]});
const headers={authorization:'Bearer isolated-admin','x-float-assistant-billing':'token-v1'};

async function fixture(t,{auth:customAuth,withGlobalRateLimit=false}={}){
  t.mock.timers.enable({apis:['Date'],now:Date.UTC(2026,10,4,12)});
  const app=Fastify({logger:false});
  if(withGlobalRateLimit){
    await app.register(rateLimit,{global:true,max:1,timeWindow:'1 minute'});
    app.get('/fixture/global-rate-limit',async()=>({ok:true}));
  }
  app.setErrorHandler((error,_req,reply)=>reply.code(error.statusCode||500).send({error:{code:error.code||'UNEXPECTED',message:error.message}}));
  const config={catalogKey:'deepseek-flash',provider:'deepseek',modelId:'deepseek-flash',baseUrl:'https://api.deepseek.com',
    execution:'official',pointsPerCall:0.5,maxOutputTokens:2048,enabled:true};
  const store=await AsyncSqliteStore.open(':memory:');
  store.environmentModelKeyFingerprint=()=>sha256(secret);
  await store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,points_balance) VALUES(?,?,?,?,?,?,?)',
    'isolated-owner','isolated-owner','合成账号','not-a-real-password','admin',0,1000);
  await store.run('INSERT INTO models(id,config,encrypted_key,key_fingerprint,last_test_status,revision,created_at) VALUES(?,?,?,?,?,?,?)',
    'synthetic-model',JSON.stringify(config),null,sha256(secret),'passed',1,0);
  const auth=customAuth??(async req=>{
    if(!req.headers.authorization)throw new ApiError(401,'UNAUTHORIZED','缺少登录');
    req.auth={role:req.headers.authorization===headers.authorization?'admin':'user',user_id:'isolated-owner'};
  });
  await assistantRoutes(app,{store,auth,deepseekApiKey:secret});
  await app.ready();t.after(async()=>{await app.close();await store.close();});return app;
}

function streamResult(values){
  values=values.map(value=>value.choices?.some(choice=>choice.finish_reason)?{...value,
    usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:100}}:value);
  return new Response(values.map(value=>`data: ${JSON.stringify(value)}\n\n`).join('')+'data: [DONE]\n\n',
    {headers:{'content-type':'text/event-stream'}});
}

test('assistant chat allows more than twenty sequential requests without disabling other route limits',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async()=>{
    calls++;
    return streamResult([{choices:[{delta:{content:'独立请求已返回。'},finish_reason:null}]},
      {choices:[{delta:{},finish_reason:'stop'}]}]);
  };
  const app=await fixture(t,{withGlobalRateLimit:true});
  for(let index=0;index<25;index++){
    const result=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload(`unlimited_chat_${index}`)});
    assert.equal(result.statusCode,200,result.body);
    assert(result.body.includes('[DONE]'),result.body);
    assert(!result.body.includes('ASSISTANT_RATE_LIMITED'),result.body);
  }
  assert.equal(calls,25);
  assert.equal((await app.inject({url:'/fixture/global-rate-limit'})).statusCode,200);
  assert.equal((await app.inject({url:'/fixture/global-rate-limit'})).statusCode,429);
});

test('chat route bills logged-in users and administrators and replays without a duplicate model call',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let calls=0;
  globalThis.fetch=async()=>{calls++;return streamResult([
    {choices:[{delta:{content:'矩阵是按行列排列的数字，可以描述线性变换。'},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'stop'}]}
  ]);};
  const app=await fixture(t);
  assert.equal((await app.inject({method:'POST',url:'/v1/assistant/chat',payload:payload()})).statusCode,401);
  assert.equal((await app.inject({method:'POST',url:'/v1/assistant/chat',headers:{authorization:'Bearer isolated-user'},payload:payload()})).statusCode,426);
  const ordinary=await app.inject({method:'POST',url:'/v1/assistant/chat',headers:{...headers,authorization:'Bearer isolated-user'},payload:payload('ordinary_chat')});
  assert.equal(ordinary.statusCode,200,ordinary.body);assert.match(ordinary.body,/"mode":"token"/u);
  const first=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload()});
  assert.equal(first.statusCode,200,first.body);assert.match(first.headers['content-type'],/^text\/event-stream/u);
  assert.match(first.body,/矩阵是按行列/u);assert.match(first.body,/"mode":"token"/u);assert(!first.body.includes(secret));
  const replay=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload()});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().choices[0].message.content,'矩阵是按行列排列的数字，可以描述线性变换。');
  assert.equal(calls,2);
  const conflict=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload('route_chat_1','不同内容')});
  assert.equal(conflict.statusCode,409);assert.equal(calls,2);
});

test('a phone handoff is withheld when the session is revoked during generation',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let revoked=false,authChecks=0;
  const app=await fixture(t,{auth:async req=>{
    authChecks++;
    if(revoked)throw new ApiError(401,'SESSION_REVOKED','会话已撤销');
    req.auth={role:'admin',user_id:'isolated-owner'};
  }});
  globalThis.fetch=async()=>{revoked=true;return streamResult([
    {choices:[{delta:{tool_calls:[{index:0,id:'route_call',type:'function',function:{name:'control_phone',arguments:'{"task":"打开显示设置"}'}}]},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'tool_calls'}]}
  ]);};
  const result=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload('revoked_chat','打开显示设置')});
  assert.equal(result.statusCode,200,result.body);assert.match(result.body,/SESSION_REVOKED/u);
  assert(!result.body.includes('control_phone'));assert.equal(authChecks,2);
});

test('a complete fragmented phone tool signal is delivered once after terminal authentication',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let authChecks=0;
  const app=await fixture(t,{auth:async req=>{authChecks++;req.auth={role:'admin',user_id:'isolated-owner'};}});
  globalThis.fetch=async()=>streamResult([
    {choices:[{delta:{content:'我会打开显示设置。'},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:0,id:'complete_tool',type:'function',function:{name:'control_',arguments:'{"task":"打开'}}]},finish_reason:null}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{name:'phone',arguments:'显示设置"}'}}]},finish_reason:null}]},
    {choices:[{delta:{},finish_reason:'tool_calls'}]}
  ]);
  const result=await app.inject({method:'POST',url:'/v1/assistant/chat',headers,payload:payload('complete_phone','打开显示设置')});
  assert.equal(result.statusCode,200,result.body);
  const events=result.body.split('\n').filter(line=>line.startsWith('data: ')&&!line.includes('[DONE]')).map(line=>JSON.parse(line.slice(6)));
  const signals=events.flatMap(event=>event.choices?.flatMap(choice=>choice.delta?.tool_calls||[])||[]);
  assert.equal(signals.length,1);assert.equal(signals[0].function.name,'control_phone');
  assert.deepEqual(JSON.parse(signals[0].function.arguments),{task:'打开显示设置'});assert.equal(authChecks,2);
  assert.equal(events.at(-1).billing.mode,'token');assert.equal(events.at(-1).billing.state,'settled');
});

test('disconnecting a streaming client aborts the in-flight supplier read',{timeout:5000},async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  let confirmAbort;
  const aborted=new Promise(resolve=>{confirmAbort=resolve;});
  globalThis.fetch=async(_url,options)=>new Response(new ReadableStream({start(controller){
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{delta:{content:'这是一段足够长的公开回答，用于确认实际流式客户端断开后供应商读取会被取消。'},finish_reason:null}]})}\n\n`));
    options.signal.addEventListener('abort',()=>{confirmAbort();controller.error(new Error('synthetic supplier cancellation'));},{once:true});
  }}),{headers:{'content-type':'text/event-stream'}});
  const app=await fixture(t);
  await app.listen({host:'127.0.0.1',port:0});
  const port=app.server.address().port;
  const data=JSON.stringify(payload('disconnect_chat'));
  await new Promise((resolve,reject)=>{
    const req=httpRequest({hostname:'127.0.0.1',port,path:'/v1/assistant/chat',method:'POST',
      headers:{...headers,'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
      res.once('data',()=>{req.destroy();resolve();});
    });
    req.on('error',error=>{if(error.code!=='ECONNRESET')reject(error);});req.end(data);
  });
  await aborted;
});
