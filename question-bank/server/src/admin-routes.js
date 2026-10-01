import {ApiError,fields,text,id,sha256,authenticate} from './security.js';
import {accountInfo,userInfo,points} from './account.js';
import {modelConfig,modelView,sealKey,openKey,officialModelTest,providerFailureCode} from './models.js';
const missing=()=>{throw new ApiError(404,'NOT_FOUND','记录不存在');};
const conflict=()=>{throw new ApiError(409,'VERSION_CONFLICT','记录已变化，请刷新后重试');};
function timestamp(value){if(value===null||value===undefined)return null;const n=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(n))throw new ApiError(400,'INVALID_REQUEST','日期须为ISO时间或null');return n;}
const modelFields=['provider','displayName','modelId','baseUrl','apiKey','removeKey','enabled','capabilities','maxOutputTokens','timeoutMs','dailyRequestLimit','pointsPerCall','catalogKey','expectedRevision'];
export function adminRoutes(app,{store,auth,admin,idem,integer,modelMasterKey,modelTransport=officialModelTest}){
  const sqlPage=(req,sql,args=[])=>{const limit=integer(req.query.limit,50,1,200),offset=integer(req.query.cursor,0,0,100000000);const rows=store.all(sql+' LIMIT ? OFFSET ?',...args,limit+1,offset);return {items:rows.slice(0,limit),nextCursor:rows.length>limit?String(offset+limit):null};};
  app.get('/v1/admin/users',{preHandler:admin},async req=>{
    const where=[],args=[];
    if(req.query.search){where.push('(phone_number LIKE ? ESCAPE \'!\' OR display_name LIKE ? ESCAPE \'!\')');const value='%'+text(req.query.search,'search',1,128).replace(/[!%_]/gu,'!$&')+'%';args.push(value,value);}
    if(req.query.membership){if(!['free','sponsor'].includes(req.query.membership))throw new ApiError(400,'INVALID_REQUEST','membership无效');where.push('membership=?');args.push(req.query.membership);}
    if(req.query.disabled!==undefined){if(!['true','false'].includes(req.query.disabled))throw new ApiError(400,'INVALID_REQUEST','disabled无效');where.push('disabled=?');args.push(req.query.disabled==='true'?1:0);}
    const page=sqlPage(req,`SELECT * FROM users ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id`,args);page.items=page.items.map(u=>userInfo(store,u));return page;
  });
  const user=req=>{const u=store.get('SELECT * FROM users WHERE id=?',req.params.id);if(!u)missing();return u;};
  const change=(req,allowed,action,fn)=>{fields(req.body,allowed);const reason=text(req.body.reason,'reason',1,2000);return idem(req,sha256(JSON.stringify(req.body)),()=>{const u=user(req);if(req.body.expectedRevision!==undefined&&req.body.expectedRevision!==u.revision)conflict();const result=fn(u,reason);store.audit(req.auth.user_id,action,u.id,{reason});return result??userInfo(store,store.get('SELECT * FROM users WHERE id=?',u.id));});};
  app.post('/v1/admin/users/:id/membership',{preHandler:admin},async req=>change(req,['membership','membershipExpiresAt','expectedRevision','reason'],'membership',(u)=>{
    if(req.body.expectedRevision!==u.revision)conflict();if(!['free','sponsor'].includes(req.body.membership))throw new ApiError(400,'INVALID_REQUEST','会员类型无效');
    const expires=req.body.membership==='sponsor'?timestamp(req.body.membershipExpiresAt):null;
    store.run('UPDATE users SET membership=?,membership_expires=?,revision=revision+1 WHERE id=?',req.body.membership,expires,u.id);
  }));
  app.post('/v1/admin/users/:id/status',{preHandler:admin},async req=>change(req,['disabled','expectedRevision','reason'],'account-status',(u)=>{
    if(req.body.expectedRevision!==u.revision)conflict();if(typeof req.body.disabled!=='boolean')throw new ApiError(400,'INVALID_REQUEST','disabled须为布尔值');
    if(req.body.disabled&&(u.id===req.auth.user_id||(u.role==='admin'&&!u.disabled&&store.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0").n<=1)))throw new ApiError(422,'VALIDATION_FAILED','不能禁用自己或最后一个可用管理员');
    store.run('UPDATE users SET disabled=?,revision=revision+1 WHERE id=?',req.body.disabled?1:0,u.id);if(req.body.disabled)store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',u.id);
  }));
  app.post('/v1/admin/users/:id/revoke-sessions',{preHandler:admin},async req=>change(req,['reason'],'revoke-sessions',u=>{store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',u.id);return {userId:u.id,status:'revoked'};}));
  app.post('/v1/admin/users/:id/points-adjustments',{preHandler:admin},async req=>change(req,['delta','expectedRevision','reason'],'points-adjustment',(u,reason)=>{
    if(req.body.expectedRevision!==u.revision)conflict();points(store,u,req.body.delta,req.auth.user_id,reason,`admin:${req.auth.user_id}:${req.url}:${req.headers['idempotency-key']}`);
  }));
  const ledger=(req,userId)=>{const page=sqlPage(req,'SELECT id,delta,balance_before AS balanceBefore,balance_after AS balanceAfter,reason,actor_id AS actorId,created_at AS createdAt FROM points_ledger WHERE user_id=? ORDER BY created_at DESC,id',[userId]);page.items.forEach(i=>i.createdAt=new Date(i.createdAt).toISOString());return page;};
  app.get('/v1/me/points-ledger',{preHandler:auth},async req=>ledger(req,req.auth.user_id));
  app.get('/v1/admin/users/:id/points-ledger',{preHandler:admin},async req=>ledger(req,user(req).id));
  app.get('/v1/admin/audit',{preHandler:admin},async req=>sqlPage(req,'SELECT id,actor_id AS actorId,action,target_id AS targetId,details,created_at AS createdAt FROM audit ORDER BY id DESC'));
  app.get('/v1/admin/releases',{preHandler:admin},async req=>sqlPage(req,'SELECT id AS releaseId,public_bank_id AS bankId,data_version AS dataVersion,release_sequence AS releaseSequence,title,state,source_bank_id AS sourceBankId,source_version AS sourceDataVersion FROM releases ORDER BY release_sequence DESC'));
  const model=req=>{const row=store.get('SELECT * FROM models WHERE id=?',req.params.id);if(!row)missing();return row;};
  app.get('/v1/admin/models',{preHandler:admin},async req=>{const page=sqlPage(req,'SELECT * FROM models ORDER BY created_at DESC,id');page.items=page.items.map(modelView);return page;});
  function saveModel(req,old=null){
    fields(req.body,modelFields);if(old&&req.body.expectedRevision!==old.revision)conflict();
    const config=modelConfig(req.body,old?JSON.parse(old.config):{});let encrypted=old?.encrypted_key??null,fingerprint=old?.key_fingerprint??null;
    if(config.catalogKey&&store.all('SELECT id,config FROM models WHERE id<>?',old?.id??'').some(row=>JSON.parse(row.config).catalogKey===config.catalogKey))throw new ApiError(409,'VERSION_CONFLICT','该目录型号已绑定另一模型配置');
    if(req.body.removeKey===true){encrypted=null;fingerprint=null;config.enabled=false;}
    if(req.body.apiKey!==undefined&&(typeof req.body.apiKey!=='string'||/[\r\n]/u.test(req.body.apiKey)))throw new ApiError(400,'INVALID_REQUEST','API Key须为不含换行的文本');
    if(req.body.apiKey?.trim()){encrypted=sealKey(req.body.apiKey.trim(),modelMasterKey);fingerprint=sha256(req.body.apiKey.trim());}
    const changed=!old||fingerprint!==old.key_fingerprint||['provider','baseUrl','modelId','capabilities','maxOutputTokens'].some(k=>JSON.stringify(config[k])!==JSON.stringify(JSON.parse(old.config)[k]));
    if(config.enabled&&(!encrypted||changed||old?.last_test_status!=='passed'))throw new ApiError(422,'VALIDATION_FAILED','启用前必须通过对应配置的真实测试');
    const modelId=old?.id||id('model'),revision=(old?.revision||0)+1;
    if(old)store.run('UPDATE models SET config=?,encrypted_key=?,key_fingerprint=?,revision=?,last_test_at=?,last_test_status=?,last_test_error=?,last_test_result=? WHERE id=?',JSON.stringify(config),encrypted,fingerprint,revision,changed?null:old.last_test_at,changed?null:old.last_test_status,changed?null:old.last_test_error,changed?null:old.last_test_result,modelId);
    else store.run('INSERT INTO models(id,config,encrypted_key,key_fingerprint,revision,created_at) VALUES(?,?,?,?,?,?)',modelId,JSON.stringify(config),encrypted,fingerprint,revision,Date.now());
    store.audit(req.auth.user_id,'model-config',modelId,{revision,keyConfigured:!!encrypted});return modelView(store.get('SELECT * FROM models WHERE id=?',modelId));
  }
  app.post('/v1/admin/models',{preHandler:admin},async req=>idem(req,sha256(JSON.stringify(req.body)),()=>saveModel(req)));
  app.patch('/v1/admin/models/:id',{preHandler:admin},async req=>idem(req,sha256(JSON.stringify(req.body)),()=>saveModel(req,model(req))));
  app.post('/v1/admin/models/:id/test',{preHandler:admin},async req=>{
    fields(req.body,['expectedRevision']);const row=model(req);const key=`${req.url}|${text(req.headers['idempotency-key'],'Idempotency-Key',1,128)}`,digest=sha256(JSON.stringify(req.body));
    const previous=store.get('SELECT * FROM model_tests WHERE actor_id=? AND idempotency_key=?',req.auth.user_id,key);
    if(previous){if(previous.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','测试幂等键已用于其他版本');return previous.result?JSON.parse(previous.result):{testId:previous.id,status:previous.status,errorCode:'AWAITING_PROVIDER_RECONCILIATION'};}
    if(req.body.expectedRevision!==row.revision)conflict();if(!row.encrypted_key)throw new ApiError(422,'VALIDATION_FAILED','API Key未配置');
    const config=JSON.parse(row.config),since=Date.now()-86400000;
    const attempts=store.get('SELECT COUNT(*) AS n FROM model_tests WHERE model_id=? AND created_at>?',row.id,since).n+store.get('SELECT COUNT(*) AS n FROM ai_requests WHERE model_id=? AND created_at>?',row.id,since).n;
    if(attempts>=config.dailyRequestLimit)throw new ApiError(429,'RATE_LIMITED','已达到模型每日调用预算');
    const secret=openKey(row.encrypted_key,modelMasterKey),testId=id('test');
    store.run('INSERT INTO model_tests(id,model_id,actor_id,idempotency_key,request_hash,status,created_at) VALUES(?,?,?,?,?,?,?)',testId,row.id,req.auth.user_id,key,digest,'pending',Date.now());
    store.run("UPDATE models SET last_test_at=?,last_test_status='pending',last_test_error=NULL,last_test_result=? WHERE id=?",Date.now(),JSON.stringify({testId,status:'pending'}),row.id);
    let result;
    try {
      const receipt=await modelTransport(config,secret);
      if(receipt.status!=='passed'||!receipt.usage||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(receipt.usage[k])&&receipt.usage[k]>=0))throw new Error('INVALID_TEST_RESULT');
      const providerRequestId=typeof receipt.providerRequestId==='string'?receipt.providerRequestId.slice(0,200):null;
      if(providerRequestId?.includes(secret))throw new Error('INVALID_PROVIDER_RESPONSE');
      result={testId,status:'passed',latencyMs:Number.isFinite(receipt.latencyMs)?Math.max(0,receipt.latencyMs):null,providerRequestId,
        usage:{prompt_tokens:receipt.usage.prompt_tokens,completion_tokens:receipt.usage.completion_tokens,total_tokens:receipt.usage.total_tokens}};
    }
    catch(error){const code=providerFailureCode(error);result={testId,status:code.endsWith('_UNKNOWN')?'uncertain':'failed',errorCode:code};}
    store.run('UPDATE model_tests SET status=?,result=? WHERE id=?',result.status,JSON.stringify(result),testId);
    // Always persist the billing-attempt receipt, but never bless a changed or newly forbidden configuration.
    const fresh=store.get('SELECT * FROM models WHERE id=?',row.id);let authorized=true;try{const s=authenticate(store,req);authorized=s.role==='admin';}catch{authorized=false;}
    if(fresh.revision===row.revision&&authorized)store.run('UPDATE models SET last_test_at=?,last_test_status=?,last_test_error=?,last_test_result=? WHERE id=?',Date.now(),result.status,result.errorCode??null,JSON.stringify(result),row.id);
    store.audit(req.auth.user_id,'model-test',row.id,{testId,status:result.status,errorCode:result.errorCode??null});return result;
  });
  function announcement(row){return {id:row.id,title:row.title,body:row.body,version:row.version,status:row.status,audience:row.audience,publishedAt:row.published_at?new Date(row.published_at).toISOString():null,startsAt:row.starts_at?new Date(row.starts_at).toISOString():null,endsAt:row.ends_at?new Date(row.ends_at).toISOString():null};}
  function saveAnnouncement(req,old=null){
    fields(req.body,['title','body','status','audience','startsAt','endsAt','expectedVersion']);if(old&&req.body.expectedVersion!==old.version)conflict();
    const title=text(req.body.title??old?.title,'title',1,200),body=text(req.body.body??old?.body,'body',1,16000),status=req.body.status??old?.status??'draft',audience=req.body.audience??old?.audience??'all';
    if(!['draft','published','withdrawn'].includes(status)||!['all','free','sponsor'].includes(audience))throw new ApiError(400,'INVALID_REQUEST','公告状态或受众无效');
    const starts=req.body.startsAt===undefined?old?.starts_at??null:timestamp(req.body.startsAt),ends=req.body.endsAt===undefined?old?.ends_at??null:timestamp(req.body.endsAt);
    if(starts&&ends&&ends<=starts)throw new ApiError(400,'INVALID_REQUEST','公告结束时间须晚于开始时间');
    const announcementId=old?.id||id('announcement'),version=(old?.version||0)+1,published=status==='published'?(old?.published_at||Date.now()):old?.published_at??null;
    if(old)store.run('UPDATE announcements SET title=?,body=?,version=?,status=?,audience=?,published_at=?,starts_at=?,ends_at=? WHERE id=?',title,body,version,status,audience,published,starts,ends,announcementId);
    else store.run('INSERT INTO announcements(id,title,body,version,status,audience,published_at,starts_at,ends_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',announcementId,title,body,version,status,audience,published,starts,ends,Date.now());
    store.audit(req.auth.user_id,'announcement',announcementId,{version,status});return announcement(store.get('SELECT * FROM announcements WHERE id=?',announcementId));
  }
  app.get('/v1/admin/announcements',{preHandler:admin},async req=>{const p=sqlPage(req,'SELECT * FROM announcements ORDER BY created_at DESC,id');p.items=p.items.map(announcement);return p;});
  app.post('/v1/admin/announcements',{preHandler:admin},async req=>idem(req,sha256(JSON.stringify(req.body)),()=>saveAnnouncement(req)));
  app.patch('/v1/admin/announcements/:id',{preHandler:admin},async req=>idem(req,sha256(JSON.stringify(req.body)),()=>{const row=store.get('SELECT * FROM announcements WHERE id=?',req.params.id);if(!row)missing();return saveAnnouncement(req,row);}));
  app.get('/v1/announcements',{preHandler:auth},async req=>{
    const now=Date.now(),user=store.get('SELECT * FROM users WHERE id=?',req.auth.user_id),effective=user.membership==='sponsor'&&(user.membership_expires===null||user.membership_expires>now)?'sponsor':'free';
    const rows=store.all(`SELECT a.* FROM announcements a WHERE status='published' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) AND audience IN ('all',?) ${req.query.includeDismissed==='true'?'':"AND NOT EXISTS(SELECT 1 FROM announcement_dismissals d WHERE d.user_id=? AND d.announcement_id=a.id AND d.version=a.version)"} ORDER BY published_at DESC LIMIT 201`,now,now,effective,...(req.query.includeDismissed==='true'?[]:[user.id]));
    if(rows.length>200)throw new ApiError(503,'UNAVAILABLE','公告目录超过处理预算');return {items:rows.map(announcement)};
  });
  app.post('/v1/announcements/:id/dismiss',{preHandler:auth},async req=>{
    fields(req.body,['version']);const row=store.get('SELECT * FROM announcements WHERE id=?',req.params.id);if(!row)missing();if(req.body.version!==row.version)conflict();
    store.run('INSERT OR IGNORE INTO announcement_dismissals(user_id,announcement_id,version,created_at) VALUES(?,?,?,?)',req.auth.user_id,row.id,row.version,Date.now());return {id:row.id,version:row.version,dismissed:true};
  });
}
