import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import rateLimit from '@fastify/rate-limit';
import {fileURLToPath} from 'node:url';
import {Store} from './store.js';
import {ApiError, credentials, fields, text, newPassword, phoneNumber, hashPassword, verifyPassword, issueSession, safeUser, authenticate, sha256, id, OFFLINE_MS} from './security.js';
import {parseFile} from './parser.js';
import {inspectQuestion,TYPES} from './questions.js';
import {SmsService} from './sms.js';
import {ExternalPhoneService} from './external-phone.js';
import {accountInfo,points,requirePositivePoints} from './account.js';
import {adminRoutes} from './admin-routes.js';
import {registerAppUpdateRoutes} from './app-updates.js';
import {aiRoutes} from './ai-routes.js';

const UPLOAD_LIMIT=10*1024*1024;
const missing=()=>{throw new ApiError(404,'NOT_FOUND','未找到可访问的记录');};
const conflict=message=>{throw new ApiError(409,'VERSION_CONFLICT',message);};
function integer(value,fallback,min=0,max=200) { const n=value===undefined?fallback:Number(value);if(!Number.isSafeInteger(n)||n<min||n>max)throw new ApiError(400,'INVALID_REQUEST','分页或版本参数无效');return n; }
function page(items,query) {
  const limit=integer(query.limit,50,1,200); const offset=integer(query.cursor,0,0,100000000);
  return {items:items.slice(offset,offset+limit),nextCursor:offset+limit<items.length?String(offset+limit):null};
}
function principal(store,session) { return safeUser(store.get('SELECT * FROM users WHERE id=?',session.user_id)); }
function importSummary(items) {
  return {questionCount:items.length,errorCount:items.reduce((n,q)=>n+q.errors.length,0),
    reviewQuestionCount:items.filter(q=>q.errors.length||q.answerComplete!==true).length};
}
function importInfo(row) {
  const items=JSON.parse(row.preview);const errors=items.flatMap(q=>q.errors.map(message=>({questionId:q.questionId,message})));
  return {importId:row.id,status:row.status,revision:row.revision,filename:row.filename,format:row.format,title:row.title,
    ...importSummary(items),warnings:JSON.parse(row.warnings),errors,
    ...(row.committed_bank_id?{bankId:row.committed_bank_id,dataVersion:row.committed_version}:{})};
}
function privateEntry(bank,version) {
  return {bankId:bank.id,title:bank.title,visibility:'private',ownerUserId:bank.owner_id,dataVersion:version.data_version,
    releaseSequence:version.sequence,questionCount:version.question_count,importedAt:bank.created_at,description:bank.description,
    package:{format:'question-bank-json-v2',path:`/v1/sync/packages/${version.data_version}`,sha256:version.sha256,sizeBytes:version.size_bytes}};
}
function publicEntry(row) {return {bankId:row.public_bank_id,title:row.title,visibility:'public',ownerUserId:null,dataVersion:row.data_version,
  releaseSequence:row.release_sequence,questionCount:row.question_count,
  package:{format:'question-bank-json-v2',path:`/v1/sync/packages/${row.data_version}`,sha256:row.sha256,sizeBytes:row.size_bytes}};}
function indexedQuestions(payload) {
  const counts=Object.fromEntries(TYPES.map(type=>[type,0]));
  const questions=payload.questions.map((question,index)=>{
    const questionType=TYPES.includes(question.questionType)?question.questionType:'unknown';
    counts[questionType]++;
    return {...question,questionType,ordinal:index+1,groupOrdinal:counts[questionType]};
  });
  return {questions,typeCounts:{...counts}};
}
export async function buildApp({database=':memory:',logger=false,rateLimits=true,smsTransport=null,smsHmacKey=null,smsLimits=true,phoneVerifier=null,testHooks={},modelMasterKey=null,modelTransport,aiTransport,appUpdateDirectory=null}={}) {
  const store=new Store(database);
  for(const pending of store.all("SELECT id,model_id,actor_id FROM model_tests WHERE status='pending'"))store.transaction(()=>{
    const result=JSON.stringify({testId:pending.id,status:'uncertain',errorCode:'PROCESS_INTERRUPTED'});
    store.run("UPDATE model_tests SET status='uncertain',result=? WHERE id=?",result,pending.id);
    store.run("UPDATE models SET last_test_status='uncertain',last_test_error='PROCESS_INTERRUPTED',last_test_result=? WHERE id=? AND last_test_status='pending'",result,pending.model_id);
    store.audit(pending.actor_id,'model-test-recovery',pending.model_id,{testId:pending.id,status:'uncertain'});
  });
  const sms=phoneVerifier?new ExternalPhoneService(store,{verifier:phoneVerifier,limits:smsLimits}):new SmsService(store,{transport:smsTransport,hmacKey:smsHmacKey,limits:smsLimits});
  const app=Fastify({logger:logger?{level:'info',redact:['req.headers.authorization','req.headers.cookie','req.body.apiKey','req.body.byok.apiKey','res.headers.set-cookie']}:false,
    bodyLimit:4*1024*1024,trustProxy:['127.0.0.1','::1'],requestTimeout:30000});
  app.decorate('store',store);
  app.addHook('onClose',async()=>store.close());
  await app.register(multipart,{limits:{files:1,fields:1,parts:2,fileSize:UPLOAD_LIMIT,fieldSize:512}});
  await app.register(rateLimit,{global:rateLimits,max:120,timeWindow:'1 minute',errorResponseBuilder:()=>({error:{code:'RATE_LIMITED',message:'请求过于频繁',retryable:true}})});
  app.addHook('onSend',async(request,reply,payload)=>{
    reply.header('X-Content-Type-Options','nosniff').header('Referrer-Policy','no-referrer')
      .header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    if(request.url.startsWith('/v1'))reply.header('Cache-Control','no-store');
    return payload;
  });
  app.setErrorHandler((error,request,reply)=>{
    let status=error.statusCode||500;
    let code=error instanceof ApiError?error.code:status===413?'TOO_LARGE':status===400?'INVALID_REQUEST':'UNAVAILABLE';
    if(status>=500)app.log.error({code,requestId:request.id},'Request failed');
    // Parser errors can embed fragments of malformed JSON, including passwords or API Keys.
    const publicMessage=error instanceof ApiError?error.message:status>=500?'服务暂不可用':status===413?'请求内容超过处理范围':status===429?'请求过于频繁':'请求格式无效';
    reply.code(status).send({error:{code,message:publicMessage,requestId:request.id,retryable:status===429||status>=500,
      ...(error instanceof ApiError&&error.details?.recoveryAvailable===true?{recoveryAvailable:true}:{})}});
  });
  const auth=async req=>{req.auth=authenticate(store,req);};
  const admin=async req=>{await auth(req);if(req.auth.role!=='admin')throw new ApiError(403,'FORBIDDEN','需要管理员权限');};
  const authConfig={config:{rateLimit:rateLimits?{max:12,timeWindow:'1 minute'}:false}};
  const loginFailures=new Map();
  function rateName(username) {
    if(!rateLimits)return;
    const key=sha256(username), now=Date.now();
    if(loginFailures.size>10000)for(const [k,v] of loginFailures)if(v.until<now)loginFailures.delete(k);
    const value=loginFailures.get(key);
    if(value&&value.until>now&&value.count>=12)throw new ApiError(429,'RATE_LIMITED','认证请求过于频繁');
    loginFailures.set(key,{count:value&&value.until>now?value.count+1:1,until:value&&value.until>now?value.until:now+60000});
  }
  app.get('/health',async()=>({status:'ok',schemaVersion:8}));
  app.post('/v1/auth/registration-code',authConfig,async(req,reply)=>{fields(req.body,['username']);const result=await sms.challenge(req.body.username,req.ip,{purpose:'registration'});reply.code(202);return result;});
  app.post('/v1/auth/register',authConfig,async(req,reply)=>{
    const data=credentials(req.body,true);rateName(data.username);
    text(req.body.challengeId,'challengeId',1,128);text(req.body.verificationCode,'verificationCode',6,6);
    if(store.get('SELECT id FROM users WHERE username=?',data.username))throw new ApiError(409,'VERSION_CONFLICT','用户名已存在');
    const proof=await sms.prepare(req.body.challengeId,data.username,req.body.verificationCode,{purpose:'registration'});
    try {
    const hash=await hashPassword(data.password);
    const result=store.transaction(()=>{
      if(store.get('SELECT id FROM users WHERE username=?',data.username))throw new ApiError(409,'VERSION_CONFLICT','用户名已存在');
      const userId=id('u'),now=Date.now();store.run('INSERT INTO users(id,username,display_name,password_hash,role,created_at,phone_number,phone_verified,last_login_at,trial_started,trial_ends) VALUES(?,?,?,?,?,?,?,?,?,?,?)',userId,data.username,data.displayName,hash,'user',now,data.username,1,now,now,now+900000);
      sms.consumePrepared(proof,userId);
      points(store,store.get('SELECT * FROM users WHERE id=?',userId),10,null,'首次注册赠送','registration-gift');
      store.audit(userId,'register',userId);return issueSession(store,store.get('SELECT * FROM users WHERE id=?',userId),data.clientId);
    });
    reply.code(201);return result;
    }catch(error){
      if(phoneVerifier){
        if(error instanceof ApiError)throw new ApiError(error.statusCode,error.code,error.message+'；请重新获取验证码');
        throw new ApiError(503,'UNAVAILABLE','注册未完成，请重新获取验证码');
      }
      throw error;
    }finally {sms.release(proof);}
  });
  app.post('/v1/auth/login',authConfig,async req=>{
    const data=credentials(req.body);rateName(data.username);const user=store.get('SELECT * FROM users WHERE username=?',data.username);
    const valid=await verifyPassword(data.password,user?.password_hash);
    if(!valid)throw new ApiError(401,'INVALID_CREDENTIALS','用户名或密码错误',sms.canRecover(user)?{recoveryAvailable:true}:undefined);
    await testHooks.afterLoginVerified?.(user);
    return store.transaction(()=>{
      const fresh=store.get('SELECT * FROM users WHERE id=?',user.id);
      if(!fresh||fresh.password_hash!==user.password_hash)throw new ApiError(401,'INVALID_CREDENTIALS','账号凭据已变化，请重新登录');
      if(fresh.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
      store.run('UPDATE users SET last_login_at=? WHERE id=?',Date.now(),fresh.id);return issueSession(store,fresh,data.clientId);
    });
  });
  app.post('/v1/auth/password-reset-code',authConfig,async(req,reply)=>{
    fields(req.body,['username']);const username=phoneNumber(req.body.username),user=store.get('SELECT * FROM users WHERE username=?',username);
    rateName(username);
    if(!user)throw new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    if(!user.phone_verified||!sms.canRecover(user))throw new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');
    const result=await sms.challenge(username,req.ip,{purpose:'password_reset',user});reply.code(202);return result;
  });
  app.post('/v1/auth/reset-password',authConfig,async(req,reply)=>{
    fields(req.body,['username','challengeId','verificationCode','newPassword','newPasswordConfirmation']);
    const username=phoneNumber(req.body.username);rateName(username);
    text(req.body.challengeId,'challengeId',1,128);text(req.body.verificationCode,'verificationCode',6,6);
    const password=newPassword(req.body.newPassword,req.body.newPasswordConfirmation,true);
    const user=store.get('SELECT * FROM users WHERE username=?',username);
    if(!user)throw new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    if(!user.phone_verified||!sms.canRecover(user))throw new ApiError(422,'RECOVERY_UNAVAILABLE','该手机号暂不可找回密码');
    const proof=await sms.prepare(req.body.challengeId,username,req.body.verificationCode,{purpose:'password_reset',user});
    try {
      const hash=await hashPassword(password);await testHooks.beforePasswordResetCommit?.(user);
      store.transaction(()=>{
        const fresh=store.get('SELECT * FROM users WHERE id=? AND username=?',user.id,username);
        if(!fresh||fresh.password_hash!==user.password_hash)throw new ApiError(409,'VERSION_CONFLICT','账号凭据已变化，请重新获取验证码');
        if(fresh.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
        if(!sms.canRecover(fresh))throw new ApiError(409,'VERSION_CONFLICT','恢复身份已变化，请重新获取验证码');
        sms.consumePrepared(proof,fresh.id);store.run('UPDATE users SET password_hash=? WHERE id=?',hash,fresh.id);
        store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',fresh.id);store.audit(fresh.id,'password-reset',fresh.id);
      });
      reply.code(204).send();
    }catch(error){
      if(phoneVerifier){
        if(error instanceof ApiError)throw new ApiError(error.statusCode,error.code,error.message+'；请重新获取验证码');
        throw new ApiError(503,'UNAVAILABLE','密码重设未完成，请重新获取验证码');
      }
      throw error;
    }finally {sms.release(proof);}
  });
  app.post('/v1/auth/refresh',authConfig,async req=>{
    fields(req.body,['refreshToken','clientId']);const token=sha256(text(req.body.refreshToken,'refreshToken',32,128));
    if(!['web','android'].includes(req.body.clientId))throw new ApiError(400,'INVALID_REQUEST','clientId无效');
    const used=store.get('SELECT * FROM used_refresh WHERE token_hash=?',token);
    if(used) { store.run('UPDATE sessions SET revoked=1 WHERE family_id=?',used.family_id);throw new ApiError(401,'REFRESH_REUSED','刷新令牌已使用，请重新登录'); }
    const session=store.get('SELECT * FROM sessions WHERE refresh_hash=?',token);
    if(!session||session.revoked||session.client_id!==req.body.clientId)throw new ApiError(401,'SESSION_REVOKED','会话不可用');
    if(session.refresh_expires<=Date.now())throw new ApiError(401,'REFRESH_EXPIRED','会话已过期');
    const user=store.get('SELECT * FROM users WHERE id=?',session.user_id);
    if(user.disabled)throw new ApiError(403,'ACCOUNT_DISABLED','账号不可用');
    return store.transaction(()=>{
      store.run('INSERT INTO used_refresh(token_hash,family_id,expires_at) VALUES(?,?,?)',token,session.family_id,session.refresh_expires);
      return issueSession(store,user,session.client_id,session);
    });
  });
  app.get('/v1/me',{preHandler:auth},async req=>({principal:principal(store,req.auth),account:accountInfo(store,store.get('SELECT * FROM users WHERE id=?',req.auth.user_id),req.auth.refresh_expires),session:{sessionId:req.auth.id,clientId:req.auth.client_id},
    serverTime:new Date().toISOString(),offlineUntil:new Date(Math.min(Date.now()+OFFLINE_MS,req.auth.refresh_expires)).toISOString()}));
  app.patch('/v1/me/profile',{preHandler:auth},async req=>{
    fields(req.body,['displayName','avatarId']);if(!Object.keys(req.body).length)throw new ApiError(400,'INVALID_REQUEST','请填写要修改的资料');
    const displayName=req.body.displayName===undefined?undefined:text(req.body.displayName,'displayName',1,128).trim();
    if(req.body.avatarId!==undefined&&req.body.avatarId!==null&&(typeof req.body.avatarId!=='string'||!/^pinterest-0[1-6]$/u.test(req.body.avatarId)))throw new ApiError(400,'INVALID_REQUEST','请选择列表中的系统头像');
    return store.transaction(()=>{
      req.auth=authenticate(store,req);const user=store.get('SELECT * FROM users WHERE id=?',req.auth.user_id);
      store.run('UPDATE users SET display_name=?,avatar_id=?,revision=revision+1 WHERE id=?',displayName??user.display_name,req.body.avatarId===undefined?user.avatar_id:req.body.avatarId,user.id);
      const updated=store.get('SELECT * FROM users WHERE id=?',user.id);store.audit(user.id,'profile-update',user.id,{displayNameChanged:displayName!==undefined,avatarChanged:req.body.avatarId!==undefined});
      return {principal:safeUser(updated),account:accountInfo(store,updated,req.auth.refresh_expires)};
    });
  });
  app.post('/v1/auth/logout',async(req,reply)=>{
    let session;
    if(req.headers.authorization){session=authenticate(store,req);if(req.body&&Object.keys(req.body).length)throw new ApiError(400,'INVALID_REQUEST','退出认证方式只能选择一种');}
    else {fields(req.body,['refreshToken','clientId']);session=store.get('SELECT * FROM sessions WHERE refresh_hash=? AND client_id=?',sha256(text(req.body.refreshToken,'refreshToken',32,128)),req.body.clientId);}
    if(session)store.run('UPDATE sessions SET revoked=1 WHERE family_id=?',session.family_id);
    reply.code(204).send();
  });
  app.post('/v1/auth/change-password',{preHandler:auth,...authConfig},async(req,reply)=>{
    fields(req.body,['currentPassword','newPassword']);const user=store.get('SELECT * FROM users WHERE id=?',req.auth.user_id);
    newPassword(req.body.newPassword);
    if(typeof req.body.currentPassword!=='string'||req.body.currentPassword.length<1||req.body.currentPassword.length>128)throw new ApiError(400,'INVALID_REQUEST','当前密码长度无效');
    if(!await verifyPassword(req.body.currentPassword,user.password_hash))throw new ApiError(401,'INVALID_CREDENTIALS','当前密码错误');
    const hash=await hashPassword(req.body.newPassword);
    await testHooks.beforePasswordCommit?.(user);
    store.transaction(()=>{authenticate(store,req);const fresh=store.get('SELECT * FROM users WHERE id=?',user.id);if(fresh.password_hash!==user.password_hash)conflict('密码已变化，请重新登录');store.run('UPDATE users SET password_hash=? WHERE id=?',hash,user.id);store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',user.id);store.audit(user.id,'change-password',user.id);});reply.code(204).send();
  });
  function idem(req,digest,fn) {
    const key=`${req.url.split('?')[0]}|${text(req.headers['idempotency-key'],'Idempotency-Key',1,128)}`;
    const found=store.get('SELECT * FROM confirmations WHERE owner_id=? AND idempotency_key=?',req.auth.user_id,key);
    if(found){if(found.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','幂等键已用于其他内容');return JSON.parse(found.result);}
    if(!fn)return null;
    return store.transaction(()=>{
      const result=fn();store.run('INSERT INTO confirmations(owner_id,idempotency_key,request_hash,result) VALUES(?,?,?,?)',req.auth.user_id,key,digest,JSON.stringify(result));return result;
    });
  }
  const ownImport=(req,administrative=false)=>{const row=store.get('SELECT * FROM imports WHERE id=?',req.params.id);if(!row||(!administrative&&row.owner_id!==req.auth.user_id))missing();return row;};
  app.post('/v1/imports',{preHandler:auth},async(req,reply)=>{
    text(req.headers['idempotency-key'],'Idempotency-Key',1,128);
    let bytes,filename,title;
    for await(const part of req.parts()) {
      if(part.type==='file'){if(part.fieldname!=='file')throw new ApiError(400,'INVALID_REQUEST','文件字段必须为file');filename=part.filename.replace(/^.*[\\/]/u,'').slice(0,200);bytes=await part.toBuffer();}
      else {if(part.fieldname!=='title')throw new ApiError(400,'INVALID_REQUEST','上传含未支持字段');title=text(part.value,'title',1,200);}
    }
    if(!bytes?.length||!filename)throw new ApiError(400,'INVALID_REQUEST','请选择非空文件');
    title=title||filename;const fileSha=sha256(bytes);const digest=sha256(JSON.stringify({filename,title,fileSha}));
    const old=idem(req,digest);if(old){reply.code(202);return old;}
    requirePositivePoints(store,req.auth.user_id);
    let parsed,status='ready';
    try {parsed=await parseFile(filename,bytes);if(parsed.items.some(q=>q.errors.length)||!parsed.items.length)status='needs_review';}
    catch(error){if(error.statusCode===415||error.statusCode===503)throw error;parsed={format:filename.split('.').pop().toLowerCase(),items:[],warnings:[error.message]};status='failed';}
    await testHooks.afterImportParsed?.(req.auth.user_id);req.auth=authenticate(store,req);
    // Recheck after awaited parsing so concurrent retries cannot create duplicates.
    const replay=idem(req,digest);if(replay){reply.code(202);return replay;}
    const result=idem(req,digest,()=>{
      requirePositivePoints(store,req.auth.user_id);
      const importId=id('i'),now=Date.now();
      store.run('INSERT INTO imports(id,owner_id,filename,format,file_sha,preview,created_at,expires_at,title,revision,status,source,warnings,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        importId,req.auth.user_id,filename,parsed.format,fileSha,JSON.stringify(parsed.items),now,now+30*86400000,title,1,status,bytes,JSON.stringify(parsed.warnings),JSON.stringify(importSummary(parsed.items)));
      store.audit(req.auth.user_id,'upload',importId,{format:parsed.format,size:bytes.length});return {importId,status,revision:1,filename};
    });reply.code(202);return result;
  });
  function importList(req,all=false){
    const limit=integer(req.query.limit,50,1,200),offset=integer(req.query.cursor,0,0,100000000);
    const rows=store.all(`SELECT id,owner_id,filename,format,title,status,revision,summary,preview,committed_bank_id,committed_version FROM imports ${all?'':'WHERE owner_id=?'} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,...(all?[]:[req.auth.user_id]),limit+1,offset);
    return {items:rows.slice(0,limit).map(r=>({importId:r.id,filename:r.filename,format:r.format,title:r.title,status:r.status,revision:r.revision,...importSummary(JSON.parse(r.preview)),...(r.committed_bank_id?{bankId:r.committed_bank_id,dataVersion:r.committed_version}:{}),...(all?{ownerUserId:r.owner_id}:{})})),nextCursor:rows.length>limit?String(offset+limit):null};
  }
  app.get('/v1/imports',{preHandler:auth},async req=>importList(req));
  app.get('/v1/imports/:id',{preHandler:auth},async req=>importInfo(ownImport(req)));
  app.get('/v1/imports/:id/questions',{preHandler:auth},async req=>{
    if(req.query.order!==undefined&&!['original','review'].includes(req.query.order))throw new ApiError(400,'INVALID_REQUEST','题目排序方式无效');
    const row=ownImport(req),items=JSON.parse(row.preview).map((item,index)=>({...item,ordinal:index+1})),offset=integer(req.query.offset,0,0,100000000),limit=integer(req.query.limit,50,1,200);
    const needsReview=item=>item.errors.length>0||item.answerComplete!==true,reviewQuestionCount=items.filter(needsReview).length;
    if(req.query.order==='review')items.sort((a,b)=>Number(needsReview(b))-Number(needsReview(a))||a.ordinal-b.ordinal);
    return {items:items.slice(offset,offset+limit),total:items.length,revision:row.revision,reviewQuestionCount,offset,nextOffset:offset+limit<items.length?offset+limit:null};
  });
  app.patch('/v1/imports/:id/questions/:questionId',{preHandler:auth},async req=>{
    requirePositivePoints(store,req.auth.user_id);
    fields(req.body,['expectedRevision','question']);const row=ownImport(req);if(row.status==='confirmed')conflict('已确认任务不可编辑，请重新导入并显式选择目标库版本');if(req.body.expectedRevision!==row.revision)conflict('预览版本已变化');
    const items=JSON.parse(row.preview),index=items.findIndex(q=>q.questionId===req.params.questionId);if(index<0)missing();
    if(req.body.question?.questionId&&req.body.question.questionId!==req.params.questionId)throw new ApiError(400,'INVALID_REQUEST','questionId不可更改');
    const checked=inspectQuestion(req.body.question,req.params.questionId,true);items[index]={...checked.question,errors:checked.errors};
    const revision=row.revision+1,status=items.some(q=>q.errors.length)?'needs_review':'ready';
    store.run('UPDATE imports SET preview=?,revision=?,status=?,summary=? WHERE id=?',JSON.stringify(items),revision,status,JSON.stringify(importSummary(items)),row.id);
    return {item:items[index],revision,status};
  });
  app.post('/v1/imports/:id/confirm',{preHandler:auth},async req=>{
    fields(req.body,['expectedRevision','title','bankId','expectedBankVersion']);const row=ownImport(req);const digest=sha256(JSON.stringify({importId:row.id,...req.body}));
    return idem(req,digest,()=>{
      if(req.body.expectedRevision!==row.revision)conflict('预览版本已变化，请重新核对');
      if(row.status==='confirmed'){const b=store.get('SELECT * FROM banks WHERE id=? AND deleted_at IS NULL',row.committed_bank_id);if(!b)missing();const v=store.get('SELECT * FROM private_versions WHERE bank_id=? AND data_version=?',b.id,row.committed_version);return {bankId:b.id,dataVersion:v.data_version,visibility:'private',questionCount:v.question_count};}
      requirePositivePoints(store,req.auth.user_id);
      if(['failed','processing'].includes(row.status))throw new ApiError(422,'VALIDATION_FAILED','解析尚未成功完成，不能确认');
      const preview=JSON.parse(row.preview);
      if(preview.some(q=>q.errors.length))throw new ApiError(422,'VALIDATION_FAILED','仍有解析或结构错误，请修正预览');
      const questions=preview.map(q=>inspectQuestion(q,q.questionId));
      if(!questions.length||questions.some(q=>q.errors.length))throw new ApiError(422,'VALIDATION_FAILED','没有可确认题目或仍有结构错误');
      if(req.body.expectedBankVersion!==undefined&&!req.body.bankId)throw new ApiError(400,'INVALID_REQUEST','expectedBankVersion必须与bankId配对');
      if(req.body.bankId&&!req.body.expectedBankVersion)throw new ApiError(400,'INVALID_REQUEST','更新已有库需要expectedBankVersion');
      const title=req.body.title===undefined?row.title:text(req.body.title,'title',1,200),bankId=req.body.bankId||row.committed_bank_id||id('b');
      const old=store.get('SELECT * FROM banks WHERE id=?',bankId),sequence=(old?.sequence||0)+1,dataVersion=id('v'),now=Date.now();
      if(req.body.bankId&&(!old||old.owner_id!==req.auth.user_id||old.deleted_at!==null))missing();
      if(old&&(old.owner_id!==req.auth.user_id||old.deleted_at!==null))missing();
      if(req.body.bankId&&old.current_version!==req.body.expectedBankVersion)conflict('目标题库版本已变化');
      if(!req.body.bankId&&old&&old.current_version!==row.committed_version)conflict('源题库版本已变化，请显式选择目标版本');
      const payload=JSON.stringify({schemaVersion:2,normalizationVersion:'text-v1',bankId,title,description:old?.description||'',visibility:'private',ownerUserId:req.auth.user_id,dataVersion,releaseSequence:sequence,
        questions:questions.map(({question})=>({...question,bankId,dataVersion}))});
      if(Buffer.byteLength(payload)>32*1024*1024)throw new ApiError(413,'TOO_LARGE','题库包超过32MiB单包预算，请拆分');
      if(old)store.run('UPDATE banks SET title=?,current_version=?,sequence=?,updated_at=? WHERE id=?',title,dataVersion,sequence,now,bankId);
      else store.run('INSERT INTO banks(id,owner_id,title,current_version,sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',bankId,req.auth.user_id,title,dataVersion,sequence,now,now);
      store.run('INSERT INTO private_versions(bank_id,data_version,sequence,payload,sha256,size_bytes,question_count,created_at) VALUES(?,?,?,?,?,?,?,?)',bankId,dataVersion,sequence,payload,sha256(payload),Buffer.byteLength(payload),questions.length,now);
      store.run("UPDATE imports SET status='confirmed',committed_bank_id=?,committed_version=?,title=? WHERE id=?",bankId,dataVersion,title,row.id);
      store.audit(req.auth.user_id,'confirm-import',bankId,{dataVersion,importId:row.id});return {bankId,dataVersion,visibility:'private',questionCount:questions.length};
    });
  });
  function source(req,reply,administrative=false){const row=ownImport(req,administrative);if(administrative)store.audit(req.auth.user_id,'admin-read-source',row.id);
    reply.header('Content-Disposition',`attachment; filename="source.${row.format.replace(/[^a-z0-9]/gu,'')}"`).type('application/octet-stream');return Buffer.from(row.source);}
  app.get('/v1/imports/:id/source',{preHandler:auth},async(req,reply)=>source(req,reply));
  function catalog(userId){
    const owned=store.all('SELECT * FROM banks WHERE owner_id=? AND deleted_at IS NULL ORDER BY id',userId).map(b=>privateEntry(b,store.get('SELECT bank_id,data_version,sequence,sha256,size_bytes,question_count FROM private_versions WHERE bank_id=? AND data_version=?',b.id,b.current_version)));
    const published=store.all("SELECT public_bank_id,title,data_version,release_sequence,question_count,sha256,size_bytes FROM releases r WHERE state='published' AND release_sequence=(SELECT MAX(r2.release_sequence) FROM releases r2 WHERE r2.public_bank_id=r.public_bank_id AND r2.state='published') ORDER BY public_bank_id").map(publicEntry);
    return [...owned,...published].sort((a,b)=>a.bankId.localeCompare(b.bankId));
  }
  app.get('/v1/banks',{preHandler:auth},async req=>{
    const limit=integer(req.query.limit,50,1,200),offset=integer(req.query.cursor,0,0,100000000);
    const rows=store.all(`SELECT b.id AS bankId,b.title,'private' AS visibility,b.owner_id AS ownerUserId,v.data_version AS dataVersion,v.sequence AS releaseSequence,v.question_count AS questionCount,b.created_at AS importedAt,b.description AS description
      FROM banks b JOIN private_versions v ON v.bank_id=b.id AND v.data_version=b.current_version WHERE b.owner_id=? AND b.deleted_at IS NULL
      UNION ALL SELECT public_bank_id,title,'public',NULL,data_version,release_sequence,question_count,created_at,'' FROM releases WHERE state='published'
      ORDER BY bankId LIMIT ? OFFSET ?`,req.auth.user_id,limit+1,offset);
    const items=rows.slice(0,limit).map(bank=>{
      const payload=JSON.parse(packagePayload(req.auth.user_id,bank.dataVersion)),typeCounts=Object.fromEntries(TYPES.map(type=>[type,0]));
      for(const question of payload.questions)typeCounts[TYPES.includes(question.questionType)?question.questionType:'unknown']++;
      return {...bank,typeCounts};
    });
    return {items,nextCursor:rows.length>limit?String(offset+limit):null};
  });
  const accessibleBank=req=>{const found=catalog(req.auth.user_id).find(b=>b.bankId===req.params.id);if(!found)missing();return found;};
  const selectedBankPayload=(req,bank)=>{
    if(req.query.dataVersion!==undefined&&text(req.query.dataVersion,'dataVersion')!==bank.dataVersion)conflict('题库版本已变化，请刷新后重试');
    return JSON.parse(packagePayload(req.auth.user_id,bank.dataVersion));
  };
  app.get('/v1/banks/:id',{preHandler:auth},async req=>{
    const bank=accessibleBank(req),payload=selectedBankPayload(req,bank),{package:p,...entry}=bank;
    return {...entry,typeCounts:indexedQuestions(payload).typeCounts};
  });
  function packagePayload(userId,dataVersion){
    const privateRow=store.get('SELECT v.payload FROM private_versions v JOIN banks b ON b.id=v.bank_id WHERE v.data_version=? AND b.owner_id=? AND b.current_version=v.data_version',dataVersion,userId);
    if(privateRow)return privateRow.payload;
    const pub=store.get("SELECT payload FROM releases WHERE data_version=? AND state='published'",dataVersion);if(!pub)missing();return pub.payload;
  }
  function questionPage(payload,query){const q=JSON.parse(payload).questions,offset=integer(query.offset,0,0,100000000),limit=integer(query.limit,50,1,200);return {items:q.slice(offset,offset+limit),total:q.length};}
  app.get('/v1/banks/:id/questions',{preHandler:auth},async req=>{
    const bank=accessibleBank(req),payload=selectedBankPayload(req,bank),indexed=indexedQuestions(payload);
    if(req.query.questionType!==undefined&&!TYPES.includes(req.query.questionType))throw new ApiError(400,'INVALID_REQUEST','questionType无效');
    if(req.query.view!==undefined&&req.query.view!=='index')throw new ApiError(400,'INVALID_REQUEST','view无效');
    const offset=integer(req.query.offset,0,0,100000000),limit=integer(req.query.limit,50,1,200);
    const filtered=req.query.questionType===undefined?indexed.questions:indexed.questions.filter(question=>question.questionType===req.query.questionType);
    const items=filtered.slice(offset,offset+limit).map(question=>req.query.view==='index'?{
      questionId:question.questionId,questionType:question.questionType,ordinal:question.ordinal,groupOrdinal:question.groupOrdinal,answerComplete:question.answerComplete
    }:question);
    return {bankId:bank.bankId,dataVersion:bank.dataVersion,items,total:filtered.length,bankTotal:indexed.questions.length,offset,nextOffset:offset+limit<filtered.length?offset+limit:null};
  });
  app.get('/v1/banks/:id/questions/:questionId',{preHandler:auth},async req=>{
    const bank=accessibleBank(req),payload=selectedBankPayload(req,bank),item=indexedQuestions(payload).questions.find(question=>question.questionId===req.params.questionId);
    if(!item)missing();return {bankId:bank.bankId,dataVersion:bank.dataVersion,item};
  });
  app.patch('/v1/banks/:id',{preHandler:auth},async req=>{
    fields(req.body,['expectedBankVersion','title','description']);
    const expected=text(req.body.expectedBankVersion,'expectedBankVersion');
    const title=text(req.body.title,'title',1,200);
    const description=text(req.body.description,'description',0,1000);
    const digest=sha256(JSON.stringify({bankId:req.params.id,expected,title,description}));
    return idem(req,digest,()=>{
      const bank=store.get('SELECT * FROM banks WHERE id=? AND owner_id=? AND deleted_at IS NULL',req.params.id,req.auth.user_id);
      if(!bank)missing();
      if(bank.current_version!==expected)conflict('题库版本已变化，请刷新后再编辑');
      if(bank.title===title && bank.description===description)return {bankId:bank.id,dataVersion:bank.current_version,title,description,unchanged:true};
      const prior=store.get('SELECT * FROM private_versions WHERE bank_id=? AND data_version=?',bank.id,bank.current_version);if(!prior)missing();
      const previous=JSON.parse(prior.payload),dataVersion=id('v'),sequence=bank.sequence+1,now=Date.now();
      const payload=JSON.stringify({...previous,bankId:bank.id,title,description,visibility:'private',ownerUserId:req.auth.user_id,
        dataVersion,releaseSequence:sequence,questions:previous.questions.map(q=>({...q,bankId:bank.id,dataVersion}))});
      const size=Buffer.byteLength(payload);if(size>32*1024*1024)throw new ApiError(413,'TOO_LARGE','题库包超过32MiB单包预算');
      store.run('UPDATE banks SET title=?,description=?,current_version=?,sequence=?,updated_at=? WHERE id=?',title,description,dataVersion,sequence,now,bank.id);
      store.run('INSERT INTO private_versions(bank_id,data_version,sequence,payload,sha256,size_bytes,question_count,created_at) VALUES(?,?,?,?,?,?,?,?)',
        bank.id,dataVersion,sequence,payload,sha256(payload),size,previous.questions.length,now);
      store.audit(req.auth.user_id,'edit-bank-metadata',bank.id,{dataVersion});
      return {bankId:bank.id,dataVersion,title,description,unchanged:false};
    });
  });
  function writeQuestion(req,create) {
    fields(req.body,['expectedBankVersion','question']);
    const expected=text(req.body.expectedBankVersion,'expectedBankVersion'),digest=sha256(JSON.stringify({bankId:req.params.id,questionId:req.params.questionId??null,create,expected,question:req.body.question}));
    return idem(req,digest,()=>{
      if(create)requirePositivePoints(store,req.auth.user_id);
      const bank=store.get('SELECT * FROM banks WHERE id=? AND owner_id=? AND deleted_at IS NULL',req.params.id,req.auth.user_id);if(!bank)missing();
      if(bank.current_version!==expected)conflict('题库版本已变化，请刷新后重试');
      if(!req.body.question||typeof req.body.question!=='object'||Array.isArray(req.body.question))throw new ApiError(400,'INVALID_REQUEST','question须为对象');
      if(create&&Object.prototype.hasOwnProperty.call(req.body.question,'questionId'))throw new ApiError(400,'INVALID_REQUEST','新增题目不得提供questionId');
      if(!create&&req.body.question.questionId!==undefined&&req.body.question.questionId!==req.params.questionId)throw new ApiError(400,'INVALID_REQUEST','questionId必须与路径一致');
      const prior=store.get('SELECT * FROM private_versions WHERE bank_id=? AND data_version=?',bank.id,bank.current_version);if(!prior)missing();
      const oldPayload=JSON.parse(prior.payload),questions=[...oldPayload.questions];
      let index=create?questions.length:questions.findIndex(question=>question.questionId===req.params.questionId);if(index<0)missing();
      const questionId=create?id('q'):req.params.questionId,checked=inspectQuestion(req.body.question,questionId,true);
      if(checked.errors.length)throw new ApiError(422,'VALIDATION_FAILED',checked.errors.join('；'));
      const dataVersion=id('v'),sequence=bank.sequence+1,now=Date.now();
      questions[index]={...checked.question,bankId:bank.id,dataVersion};
      for(let i=0;i<questions.length;i++)if(i!==index)questions[i]={...questions[i],bankId:bank.id,dataVersion};
      const payload=JSON.stringify({...oldPayload,bankId:bank.id,title:bank.title,visibility:'private',ownerUserId:req.auth.user_id,dataVersion,releaseSequence:sequence,questions});
      const size=Buffer.byteLength(payload);if(size>32*1024*1024)throw new ApiError(413,'TOO_LARGE','题库包超过32MiB单包预算，请拆分');
      store.run('UPDATE banks SET current_version=?,sequence=?,updated_at=? WHERE id=?',dataVersion,sequence,now,bank.id);
      store.run('INSERT INTO private_versions(bank_id,data_version,sequence,payload,sha256,size_bytes,question_count,created_at) VALUES(?,?,?,?,?,?,?,?)',bank.id,dataVersion,sequence,payload,sha256(payload),size,questions.length,now);
      const item=indexedQuestions(JSON.parse(payload)).questions[index];
      store.audit(req.auth.user_id,create?'add-question':'edit-question',bank.id,{dataVersion,questionId});
      return {bankId:bank.id,dataVersion,releaseSequence:sequence,questionCount:questions.length,item};
    });
  }
  app.post('/v1/banks/:id/questions',{preHandler:auth},async(req,reply)=>{const result=writeQuestion(req,true);reply.code(201);return result;});
  app.patch('/v1/banks/:id/questions/:questionId',{preHandler:auth},async req=>writeQuestion(req,false));
  app.delete('/v1/banks/:id',{preHandler:auth},async req=>{
    fields(req.body,['expectedBankVersion']);
    const expected=text(req.body.expectedBankVersion,'expectedBankVersion');
    const digest=sha256(JSON.stringify({bankId:req.params.id,expected}));
    return idem(req,digest,()=>{
      const bank=store.get('SELECT * FROM banks WHERE id=? AND owner_id=? AND deleted_at IS NULL',req.params.id,req.auth.user_id);
      if(!bank)missing();
      if(bank.current_version!==expected)conflict('题库版本已变化，请刷新后再删除');
      const published=!!store.get('SELECT id FROM releases WHERE source_bank_id=? LIMIT 1',bank.id);
      // Imported originals and every private snapshot are removed from the account.
      store.run('DELETE FROM imports WHERE owner_id=? AND committed_bank_id=?',req.auth.user_id,bank.id);
      store.run('DELETE FROM private_versions WHERE bank_id=?',bank.id);
      if(published) {
        // Immutable public releases retain their own payload and review references.
        store.run('UPDATE banks SET title=?,deleted_at=? WHERE id=?','已删除的私人题库',Date.now(),bank.id);
      } else {
        store.run('DELETE FROM reviews WHERE bank_id=?',bank.id);
        store.run('DELETE FROM banks WHERE id=?',bank.id);
      }
      store.audit(req.auth.user_id,'delete-private-bank',bank.id,{publishedSource:published});
      return {bankId:bank.id,status:'deleted'};
    });
  });
  app.get('/v1/sync/manifest',{preHandler:auth},async req=>{
    const banks=catalog(req.auth.user_id);const result={manifestVersion:2,normalizationVersion:'text-v1',subjectUserId:req.auth.user_id,catalogRevision:sha256(JSON.stringify(banks)),complete:true,generatedAt:new Date().toISOString(),banks};
    if(Buffer.byteLength(JSON.stringify(result))>512*1024)throw new ApiError(503,'UNAVAILABLE','完整清单超过512KiB处理预算，需启用分包协议后再同步');return result;
  });
  app.get('/v1/sync/packages/:id',{preHandler:auth},async(req,reply)=>reply.type('application/json; charset=utf-8').send(packagePayload(req.auth.user_id,req.params.id)));
  app.get('/v1/admin/imports',{preHandler:admin},async req=>importList(req,true));
  app.get('/v1/admin/imports/:id',{preHandler:admin},async req=>{const row=ownImport(req,true);store.audit(req.auth.user_id,'admin-read-import',row.id);return {...importInfo(row),ownerUserId:row.owner_id};});
  app.get('/v1/admin/imports/:id/source',{preHandler:admin},async(req,reply)=>source(req,reply,true));
  app.get('/v1/admin/banks',{preHandler:admin},async req=>{
    const limit=integer(req.query.limit,50,1,200),offset=integer(req.query.cursor,0,0,100000000);
    const rows=store.all('SELECT b.*,v.data_version,v.sha256,v.size_bytes,v.question_count FROM banks b JOIN private_versions v ON v.bank_id=b.id AND v.data_version=b.current_version WHERE b.deleted_at IS NULL ORDER BY b.updated_at DESC,b.id LIMIT ? OFFSET ?',limit+1,offset);
    return {items:rows.slice(0,limit).map(b=>privateEntry(b,b)),nextCursor:rows.length>limit?String(offset+limit):null};
  });
  app.get('/v1/admin/banks/:id/questions',{preHandler:admin},async req=>{
    const version=text(req.query.dataVersion,'dataVersion');const row=store.get('SELECT * FROM private_versions WHERE bank_id=? AND data_version=?',req.params.id,version);if(!row)missing();store.audit(req.auth.user_id,'admin-read-bank',req.params.id,{dataVersion:version});return questionPage(row.payload,req.query);
  });
  app.post('/v1/admin/banks/:id/reviews',{preHandler:admin},async req=>{
    fields(req.body,['dataVersion','decision','comment']);const version=text(req.body.dataVersion,'dataVersion');if(!['approved','rejected'].includes(req.body.decision))throw new ApiError(400,'INVALID_REQUEST','审核决定无效');
    const bank=store.get('SELECT * FROM banks WHERE id=? AND deleted_at IS NULL',req.params.id);if(!bank)missing();if(bank.current_version!==version)conflict('源题库版本已变化');
    const reviewId=id('review'),comment=req.body.comment===undefined?'':text(req.body.comment,'comment',0,2000);
    store.run('INSERT INTO reviews(id,bank_id,data_version,reviewer_id,decision,note,created_at) VALUES(?,?,?,?,?,?,?)',reviewId,bank.id,version,req.auth.user_id,req.body.decision,comment,Date.now());
    store.audit(req.auth.user_id,'review',bank.id,{reviewId,dataVersion:version,decision:req.body.decision});return {reviewId,bankId:bank.id,dataVersion:version,decision:req.body.decision};
  });
  app.post('/v1/admin/banks/:id/releases',{preHandler:admin},async req=>{
    fields(req.body,['dataVersion','reviewId']);const digest=sha256(JSON.stringify({bankId:req.params.id,...req.body}));
    return idem(req,digest,()=>{
      const bank=store.get('SELECT * FROM banks WHERE id=? AND deleted_at IS NULL',req.params.id);if(!bank)missing();if(bank.current_version!==req.body.dataVersion)conflict('源题库版本已变化，须重新审核');
      const review=store.get("SELECT * FROM reviews WHERE id=? AND bank_id=? AND data_version=? AND decision='approved'",req.body.reviewId,bank.id,req.body.dataVersion);if(!review)throw new ApiError(422,'VALIDATION_FAILED','缺少针对该版本的通过审核');
      if(store.get('SELECT id FROM releases WHERE source_bank_id=? AND source_version=?',bank.id,req.body.dataVersion))conflict('该源版本已发布过');
      const source=store.get('SELECT * FROM private_versions WHERE bank_id=? AND data_version=?',bank.id,req.body.dataVersion);
      const prior=store.get('SELECT public_bank_id FROM releases WHERE source_bank_id=? LIMIT 1',bank.id);
      const publicBankId=prior?.public_bank_id||id('pub'),dataVersion=id('pv'),releaseId=id('release'),seq=store.get('SELECT COALESCE(MAX(release_sequence),0)+1 AS seq FROM releases').seq;
      const payload=JSON.stringify({...JSON.parse(source.payload),bankId:publicBankId,dataVersion,visibility:'public',ownerUserId:null,releaseSequence:seq,questions:JSON.parse(source.payload).questions.map(q=>({...q,bankId:publicBankId,dataVersion}))});
      // Superseded snapshots stay immutable but cease to be downloadable/public.
      store.run("UPDATE releases SET state='withdrawn',withdrawn_at=? WHERE public_bank_id=? AND state='published'",Date.now(),publicBankId);
      store.run('INSERT INTO releases(id,public_bank_id,data_version,release_sequence,source_bank_id,source_version,review_id,publisher_id,payload,sha256,size_bytes,question_count,title,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        releaseId,publicBankId,dataVersion,seq,bank.id,req.body.dataVersion,review.id,req.auth.user_id,payload,sha256(payload),Buffer.byteLength(payload),source.question_count,bank.title,'published',Date.now());
      store.audit(req.auth.user_id,'publish',releaseId,{bankId:bank.id,dataVersion:req.body.dataVersion});
      return {releaseId,bankId:publicBankId,dataVersion,releaseSequence:seq,visibility:'public',questionCount:source.question_count};
    });
  });
  app.post('/v1/admin/releases/:releaseId/withdraw',{preHandler:admin},async req=>{
    if(req.body)fields(req.body,[]);return idem(req,sha256(req.params.releaseId),()=>{
      const release=store.get('SELECT * FROM releases WHERE id=?',req.params.releaseId);if(!release)missing();store.run("UPDATE releases SET state='withdrawn',withdrawn_at=? WHERE id=?",Date.now(),release.id);
      store.audit(req.auth.user_id,'withdraw',release.id);return {releaseId:release.id,status:'withdrawn'};
    });
  });
  adminRoutes(app,{store,auth,admin,idem,integer,modelMasterKey,modelTransport});
  aiRoutes(app,{store,auth,modelMasterKey,aiTransport,rateLimits});
  registerAppUpdateRoutes(app,{directory:appUpdateDirectory});
  await app.register(staticFiles,{root:fileURLToPath(new URL('../public/',import.meta.url)),prefix:'/',index:['index.html'],dotfiles:'deny'});
  return app;
}
