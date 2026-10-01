import {ApiError,fields,text,id,sha256,authenticate} from './security.js';
import {userInfo,points} from './account.js';
import {modelConfig,modelView,sealKey,openKey,officialModelTest,providerFailureCode} from './models.js';
const missing=()=>{throw new ApiError(404,'NOT_FOUND','记录不存在');};
const conflict=()=>{throw new ApiError(409,'VERSION_CONFLICT','记录已变化，请刷新后重试');};
function timestamp(value){if(value===null||value===undefined)return null;const n=Date.parse(value);if(typeof value!=='string'||!Number.isFinite(n))throw new ApiError(400,'INVALID_REQUEST','日期须为ISO时间或null');return n;}
const modelFields=['execution','provider','displayName','modelId','baseUrl','apiKey','removeKey','enabled','capabilities','maxOutputTokens','timeoutMs','dailyRequestLimit','pointsPerCall','catalogKey','expectedRevision'];
export function adminRoutes(app,{store,auth,admin,idem,integer,modelMasterKey,modelTransport=officialModelTest,cozeBridge=null}){
  const sqlPage=async(req,sql,args=[])=>{const limit=integer(req.query.limit,50,1,200),offset=integer(req.query.cursor,0,0,100000000);const rows=await store.all(sql+' LIMIT ? OFFSET ?',...args,limit+1,offset);return {items:rows.slice(0,limit),nextCursor:rows.length>limit?String(offset+limit):null};};
  app.get('/v1/admin/users',{preHandler:admin},async req=>{
    const where=[],args=[];
    if(req.query.search){where.push('(phone_number LIKE ? ESCAPE \'!\' OR display_name LIKE ? ESCAPE \'!\')');const value='%'+text(req.query.search,'search',1,128).replace(/[!%_]/gu,'!$&')+'%';args.push(value,value);}
    if(req.query.membership){if(!['free','sponsor'].includes(req.query.membership))throw new ApiError(400,'INVALID_REQUEST','membership无效');where.push('membership=?');args.push(req.query.membership);}
    if(req.query.disabled!==undefined){if(!['true','false'].includes(req.query.disabled))throw new ApiError(400,'INVALID_REQUEST','disabled无效');where.push('disabled=?');args.push(req.query.disabled==='true'?1:0);}
    const page=await sqlPage(req,`SELECT * FROM users ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY created_at DESC,id`,args);for(let i=0;i<page.items.length;i++)page.items[i]=await userInfo(store,page.items[i]);return page;
  });
  const user=async req=>{const u=await store.get('SELECT * FROM users WHERE id=?',req.params.id);if(!u)missing();return u;};
  const change=async(req,allowed,action,fn)=>{fields(req.body,allowed);const reason=text(req.body.reason,'reason',1,2000);return await idem(req,sha256(JSON.stringify(req.body)),async()=>{const u=await user(req);if(req.body.expectedRevision!==undefined&&req.body.expectedRevision!==u.revision)conflict();const result=await fn(u,reason);await store.audit(req.auth.user_id,action,u.id,{reason});return result??await userInfo(store,await store.get('SELECT * FROM users WHERE id=?',u.id));});};
  app.post('/v1/admin/users/:id/membership',{preHandler:admin},async req=>await change(req,['membership','membershipExpiresAt','expectedRevision','reason'],'membership',async(u)=>{
    if(req.body.expectedRevision!==u.revision)conflict();if(!['free','sponsor'].includes(req.body.membership))throw new ApiError(400,'INVALID_REQUEST','会员类型无效');
    const expires=req.body.membership==='sponsor'?timestamp(req.body.membershipExpiresAt):null;
    await store.run('UPDATE users SET membership=?,membership_expires=?,revision=revision+1 WHERE id=?',req.body.membership,expires,u.id);
  }));
  app.post('/v1/admin/users/:id/status',{preHandler:admin},async req=>await change(req,['disabled','expectedRevision','reason'],'account-status',async(u)=>{
    if(req.body.expectedRevision!==u.revision)conflict();if(typeof req.body.disabled!=='boolean')throw new ApiError(400,'INVALID_REQUEST','disabled须为布尔值');
    if(req.body.disabled&&(u.id===req.auth.user_id||(u.role==='admin'&&!u.disabled&&(await store.get("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled=0")).n<=1)))throw new ApiError(422,'VALIDATION_FAILED','不能禁用自己或最后一个可用管理员');
    await store.run('UPDATE users SET disabled=?,revision=revision+1 WHERE id=?',req.body.disabled?1:0,u.id);if(req.body.disabled)await store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',u.id);
  }));
  app.post('/v1/admin/users/:id/revoke-sessions',{preHandler:admin},async req=>await change(req,['reason'],'revoke-sessions',async u=>{await store.run('UPDATE sessions SET revoked=1 WHERE user_id=?',u.id);return {userId:u.id,status:'revoked'};}));
  app.post('/v1/admin/users/:id/points-adjustments',{preHandler:admin},async req=>await change(req,['delta','expectedRevision','reason'],'points-adjustment',async(u,reason)=>{
    if(req.body.expectedRevision!==u.revision)conflict();await points(store,u,req.body.delta,req.auth.user_id,reason,`admin:${req.auth.user_id}:${req.url}:${req.headers['idempotency-key']}`);
  }));
  const ledger=async(req,userId)=>{const page=await sqlPage(req,'SELECT id,delta,balance_before AS balanceBefore,balance_after AS balanceAfter,reason,actor_id AS actorId,created_at AS createdAt FROM points_ledger WHERE user_id=? ORDER BY created_at DESC,id',[userId]);page.items.forEach(i=>i.createdAt=new Date(i.createdAt).toISOString());return page;};
  app.get('/v1/me/points-ledger',{preHandler:auth},async req=>await ledger(req,req.auth.user_id));
  app.get('/v1/admin/users/:id/points-ledger',{preHandler:admin},async req=>await ledger(req,(await user(req)).id));
  app.get('/v1/admin/audit',{preHandler:admin},async req=>await sqlPage(req,'SELECT id,actor_id AS actorId,action,target_id AS targetId,details,created_at AS createdAt FROM audit ORDER BY id DESC'));
  app.get('/v1/admin/releases',{preHandler:admin},async req=>await sqlPage(req,'SELECT id AS releaseId,public_bank_id AS bankId,data_version AS dataVersion,release_sequence AS releaseSequence,title,state,source_bank_id AS sourceBankId,source_version AS sourceDataVersion FROM releases ORDER BY release_sequence DESC'));
  const model=async req=>{const row=await store.get('SELECT * FROM models WHERE id=?',req.params.id);if(!row)missing();return row;};
  const viewModel=row=>({...modelView(row),bridgeReady:store.cozeBridgeReady?.()===true});
  app.get('/v1/admin/models',{preHandler:admin},async req=>{const page=await sqlPage(req,'SELECT * FROM models ORDER BY created_at DESC,id');page.items=page.items.map(viewModel);return page;});
  async function cozeMetadata(){
    if(!store.cozeBridgeReady?.())throw new ApiError(503,'COZE_INTEGRATION_NOT_READY','Coze 模型集成尚未配置，请联系管理员');
    try{return await cozeBridge.metadata();}
    catch{throw new ApiError(503,'COZE_MODEL_LIST_UNAVAILABLE','暂时无法读取 Coze 真实模型目录，请稍后重试');}
  }
  app.get('/v1/admin/coze-models',{preHandler:admin},async req=>{
    const metadata=await cozeMetadata();
    req.auth=await authenticate(store,req);if(req.auth.role!=='admin')throw new ApiError(403,'FORBIDDEN','需要管理员权限');
    return metadata;
  });
  function cozeCatalogKey(modelId){
    // Bind explicit ID families to price tiers; display names and version upgrade
    // assumptions never determine billing. Unknown aliases/families are rejected.
    const value=modelId.toLowerCase().replace(/[._]/gu,'-'),date='(?:-\\d{6}(?:\\d{2})?)?';
    const doubao=new RegExp(`^doubao-(?:seed-)?(?:\\d+(?:-\\d+){0,2}-)?(pro|lite|mini)(?:-\\d+[km])?${date}$`,'u').exec(value);
    if(doubao)return `doubao-${doubao[1]}`;
    const families=[
      ['glm-turbo',`^glm-5(?:-0)?-turbo${date}$`],['glm-5',`^glm-5(?:-0)?${date}$`],['glm-4-7',`^glm-4-7${date}$`],
      ['minimax-2-5',`^minimax-m2-5${date}$`],['minimax-2-7',`^minimax-m2-7${date}$`],['qwen-plus',`^qwen-?3-5-plus${date}$`]
    ];
    return families.find(([,pattern])=>new RegExp(pattern,'u').test(value))?.[0]??null;
  }
  function previewModelConfig(body,old={}){
    const execution=body.execution??old.execution??'official';
    return modelConfig(execution==='coze'&&body.displayName===undefined&&!old.displayName?{...body,displayName:body.modelId}:body,old);
  }
  async function saveModel(req,old=null,verified=null){
    fields(req.body,modelFields);if(old&&req.body.expectedRevision!==old.revision)conflict();
    const previousConfig=old?JSON.parse(old.config):{};
    const config=previewModelConfig(req.body,previousConfig);let encrypted=old?.encrypted_key??null,fingerprint=old?.key_fingerprint??null;
    if(config.execution==='coze'){
      if(verified){
        if(verified.modelId!==config.modelId||verified.catalogKey!==config.catalogKey||verified.provider!==config.provider)conflict();
        config.displayName=verified.displayName;
      }else{
        if(!old||(previousConfig.execution??'official')!=='coze'||previousConfig.modelId!==config.modelId||previousConfig.catalogKey!==config.catalogKey)conflict();
        config.displayName=previousConfig.displayName;
      }
      // Revalidate the authoritative metadata name under the same storage constraints.
      modelConfig(config,previousConfig);
    }
    if(config.catalogKey&&(await store.all('SELECT id,config FROM models WHERE id<>?',old?.id??'')).some(row=>JSON.parse(row.config).catalogKey===config.catalogKey))throw new ApiError(409,'VERSION_CONFLICT','该目录型号已绑定另一模型配置');
    if(config.execution==='coze'){encrypted=null;fingerprint=null;}
    else{
      if(req.body.removeKey===true){encrypted=null;fingerprint=null;config.enabled=false;}
      if(req.body.apiKey!==undefined&&(typeof req.body.apiKey!=='string'||/[\r\n]/u.test(req.body.apiKey)))throw new ApiError(400,'INVALID_REQUEST','API Key须为不含换行的文本');
      if(req.body.apiKey?.trim()){encrypted=sealKey(req.body.apiKey.trim(),modelMasterKey);fingerprint=sha256(req.body.apiKey.trim());}
    }
    const oldConfig=old?JSON.parse(old.config):null;
    const changed=!old||fingerprint!==old.key_fingerprint||(oldConfig.execution??'official')!==config.execution||
      ['provider','baseUrl','modelId','catalogKey','capabilities','maxOutputTokens'].some(k=>JSON.stringify(config[k])!==JSON.stringify(oldConfig[k]));
    const ready=config.execution==='coze'?store.cozeBridgeReady?.()===true:!!encrypted;
    if(config.enabled&&(!ready||changed||old?.last_test_status!=='passed'))throw new ApiError(422,'VALIDATION_FAILED','启用前必须通过对应配置的真实测试');
    const modelId=old?.id||id('model'),revision=(old?.revision||0)+1;
    if(old)await store.run('UPDATE models SET config=?,encrypted_key=?,key_fingerprint=?,revision=?,last_test_at=?,last_test_status=?,last_test_error=?,last_test_result=? WHERE id=?',JSON.stringify(config),encrypted,fingerprint,revision,changed?null:old.last_test_at,changed?null:old.last_test_status,changed?null:old.last_test_error,changed?null:old.last_test_result,modelId);
    else await store.run('INSERT INTO models(id,config,encrypted_key,key_fingerprint,revision,created_at) VALUES(?,?,?,?,?,?)',modelId,JSON.stringify(config),encrypted,fingerprint,revision,Date.now());
    await store.audit(req.auth.user_id,'model-config',modelId,{revision,keyConfigured:!!encrypted});return viewModel(await store.get('SELECT * FROM models WHERE id=?',modelId));
  }
  async function saveModelRequest(req,updating){
    fields(req.body,modelFields);
    const digest=sha256(JSON.stringify(req.body)),previous=await idem(req,digest);
    if(previous!==null)return previous;
    const old=updating?await model(req):null,oldConfig=old?JSON.parse(old.config):{};
    if(old&&req.body.expectedRevision!==old.revision)conflict();
    const config=previewModelConfig(req.body,oldConfig);let verified=null;
    if(config.execution==='coze'&&(!old||(oldConfig.execution??'official')!=='coze'||oldConfig.modelId!==config.modelId||oldConfig.catalogKey!==config.catalogKey)){
      const metadata=await cozeMetadata(),match=metadata.items.find(item=>item.model_id===config.modelId);
      if(!match)throw new ApiError(422,'VALIDATION_FAILED','Coze 真实目录中没有该模型 ID，请重新选择');
      if(!match.input_types?.some(type=>type.toLowerCase()==='text')||!match.output_types?.some(type=>type.toLowerCase()==='text'))throw new ApiError(422,'VALIDATION_FAILED','平台元数据尚未确认该模型支持文本输入和输出');
      if(cozeCatalogKey(match.model_id)!==config.catalogKey)throw new ApiError(422,'VALIDATION_FAILED','模型 ID 的真实型号族与点数目录不匹配或无法确认，请重新选择');
      const displayName=match.show_name?.trim()||match.model_name?.trim()||match.model_id;
      verified={modelId:config.modelId,catalogKey:config.catalogKey,provider:config.provider,displayName};
    }
    // A metadata round trip must not commit after logout, revocation, role or revision changes.
    req.auth=await authenticate(store,req);
    if(req.auth.role!=='admin')throw new ApiError(403,'FORBIDDEN','需要管理员权限');
    return await idem(req,digest,async()=>await saveModel(req,updating?await model(req):null,verified));
  }
  app.post('/v1/admin/models',{preHandler:admin},async req=>await saveModelRequest(req,false));
  app.patch('/v1/admin/models/:id',{preHandler:admin},async req=>await saveModelRequest(req,true));
  app.post('/v1/admin/models/:id/test',{preHandler:admin},async req=>{
    fields(req.body,['expectedRevision']);const key=`${req.url}|${text(req.headers['idempotency-key'],'Idempotency-Key',1,128)}`,digest=sha256(JSON.stringify(req.body));
    // Reserve exactly one attempt in a database transaction. The provider call below
    // is outside this callback, so a serialization retry never calls the model twice.
    const begin=await store.transaction(async()=>{
      req.auth=await authenticate(store,req);if(req.auth.role!=='admin')throw new ApiError(403,'FORBIDDEN','需要管理员权限');
      const row=await model(req),previous=await store.get('SELECT * FROM model_tests WHERE actor_id=? AND idempotency_key=?',req.auth.user_id,key);
      if(previous){if(previous.request_hash!==digest)throw new ApiError(409,'IDEMPOTENCY_CONFLICT','测试幂等键已用于其他版本');return {replay:previous.result?JSON.parse(previous.result):{testId:previous.id,status:previous.status,errorCode:'AWAITING_PROVIDER_RECONCILIATION'}};}
      if(req.body.expectedRevision!==row.revision)conflict();
      const config=JSON.parse(row.config),since=Date.now()-86400000;
      if(config.execution==='coze'){
        if(!store.cozeBridgeReady?.())throw new ApiError(503,'COZE_INTEGRATION_NOT_READY','Coze 模型集成尚未配置，请联系管理员');
      }else if(!row.encrypted_key)throw new ApiError(422,'VALIDATION_FAILED','API Key未配置');
      const attempts=(await store.get('SELECT COUNT(*) AS n FROM model_tests WHERE model_id=? AND created_at>?',row.id,since)).n+(await store.get('SELECT COUNT(*) AS n FROM ai_requests WHERE model_id=? AND created_at>?',row.id,since)).n;
      if(attempts>=config.dailyRequestLimit)throw new ApiError(429,'RATE_LIMITED','已达到模型每日调用预算');
      const secret=config.execution==='coze'?null:openKey(row.encrypted_key,modelMasterKey),testId=id('test');
      await store.run('INSERT INTO model_tests(id,model_id,actor_id,idempotency_key,request_hash,status,created_at) VALUES(?,?,?,?,?,?,?)',testId,row.id,req.auth.user_id,key,digest,'pending',Date.now());
      await store.run("UPDATE models SET last_test_at=?,last_test_status='pending',last_test_error=NULL,last_test_result=? WHERE id=?",Date.now(),JSON.stringify({testId,status:'pending'}),row.id);
      return {row,config,secret,testId};
    });
    if(begin.replay)return begin.replay;
    const {row,config,secret,testId}=begin;
    let result;
    try {
      const receipt=await (config.execution==='coze'?cozeBridge.test(config,{requestId:testId}):modelTransport(config,secret));
      if(receipt.status!=='passed'||!receipt.usage||!['prompt_tokens','completion_tokens','total_tokens'].every(k=>Number.isSafeInteger(receipt.usage[k])&&receipt.usage[k]>=0))throw new Error('INVALID_TEST_RESULT');
      const providerRequestId=typeof receipt.providerRequestId==='string'?receipt.providerRequestId.slice(0,200):null;
      if(typeof secret==='string'&&secret&&providerRequestId?.includes(secret))throw new Error('INVALID_PROVIDER_RESPONSE');
      result={testId,status:'passed',latencyMs:Number.isFinite(receipt.latencyMs)?Math.max(0,receipt.latencyMs):null,providerRequestId,
        usage:{prompt_tokens:receipt.usage.prompt_tokens,completion_tokens:receipt.usage.completion_tokens,total_tokens:receipt.usage.total_tokens}};
    }
    catch(error){const code=providerFailureCode(error);result={testId,status:code.endsWith('_UNKNOWN')?'uncertain':'failed',errorCode:code};}
    return await store.transaction(async()=>{
      await store.run('UPDATE model_tests SET status=?,result=? WHERE id=?',result.status,JSON.stringify(result),testId);
      // Always persist the billing-attempt receipt, but never bless a changed or newly forbidden configuration.
      const fresh=await store.get('SELECT * FROM models WHERE id=?',row.id);let authorized=true;try{const s=await authenticate(store,req);authorized=s.role==='admin';}catch{authorized=false;}
      const latest=fresh&&JSON.parse(fresh.last_test_result||'{}').testId===testId;
      if(fresh?.revision===row.revision&&authorized&&latest)await store.run('UPDATE models SET last_test_at=?,last_test_status=?,last_test_error=?,last_test_result=? WHERE id=?',Date.now(),result.status,result.errorCode??null,JSON.stringify(result),row.id);
      await store.audit(req.auth.user_id,'model-test',row.id,{testId,status:result.status,errorCode:result.errorCode??null});return result;
    });
  });
  function announcement(row){return {id:row.id,title:row.title,body:row.body,version:row.version,status:row.status,audience:row.audience,publishedAt:row.published_at?new Date(row.published_at).toISOString():null,startsAt:row.starts_at?new Date(row.starts_at).toISOString():null,endsAt:row.ends_at?new Date(row.ends_at).toISOString():null};}
  async function saveAnnouncement(req,old=null){
    fields(req.body,['title','body','status','audience','startsAt','endsAt','expectedVersion']);if(old&&req.body.expectedVersion!==old.version)conflict();
    const title=text(req.body.title??old?.title,'title',1,200),body=text(req.body.body??old?.body,'body',1,16000),status=req.body.status??old?.status??'draft',audience=req.body.audience??old?.audience??'all';
    if(!['draft','published','withdrawn'].includes(status)||!['all','free','sponsor'].includes(audience))throw new ApiError(400,'INVALID_REQUEST','公告状态或受众无效');
    const starts=req.body.startsAt===undefined?old?.starts_at??null:timestamp(req.body.startsAt),ends=req.body.endsAt===undefined?old?.ends_at??null:timestamp(req.body.endsAt);
    if(starts&&ends&&ends<=starts)throw new ApiError(400,'INVALID_REQUEST','公告结束时间须晚于开始时间');
    const announcementId=old?.id||id('announcement'),version=(old?.version||0)+1,published=status==='published'?(old?.published_at||Date.now()):old?.published_at??null;
    if(old)await store.run('UPDATE announcements SET title=?,body=?,version=?,status=?,audience=?,published_at=?,starts_at=?,ends_at=? WHERE id=?',title,body,version,status,audience,published,starts,ends,announcementId);
    else await store.run('INSERT INTO announcements(id,title,body,version,status,audience,published_at,starts_at,ends_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',announcementId,title,body,version,status,audience,published,starts,ends,Date.now());
    await store.audit(req.auth.user_id,'announcement',announcementId,{version,status});return announcement(await store.get('SELECT * FROM announcements WHERE id=?',announcementId));
  }
  app.get('/v1/admin/announcements',{preHandler:admin},async req=>{const p=await sqlPage(req,'SELECT * FROM announcements ORDER BY created_at DESC,id');p.items=p.items.map(announcement);return p;});
  app.post('/v1/admin/announcements',{preHandler:admin},async req=>await idem(req,sha256(JSON.stringify(req.body)),async()=>await saveAnnouncement(req)));
  app.patch('/v1/admin/announcements/:id',{preHandler:admin},async req=>await idem(req,sha256(JSON.stringify(req.body)),async()=>{const row=await store.get('SELECT * FROM announcements WHERE id=?',req.params.id);if(!row)missing();return await saveAnnouncement(req,row);}));
  app.get('/v1/announcements',{preHandler:auth},async req=>{
    const now=Date.now(),user=await store.get('SELECT * FROM users WHERE id=?',req.auth.user_id),effective=user.membership==='sponsor'&&(user.membership_expires===null||user.membership_expires>now)?'sponsor':'free';
    const rows=await store.all(`SELECT a.* FROM announcements a WHERE status='published' AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) AND audience IN ('all',?) ${req.query.includeDismissed==='true'?'':"AND NOT EXISTS(SELECT 1 FROM announcement_dismissals d WHERE d.user_id=? AND d.announcement_id=a.id AND d.version=a.version)"} ORDER BY published_at DESC LIMIT 201`,now,now,effective,...(req.query.includeDismissed==='true'?[]:[user.id]));
    if(rows.length>200)throw new ApiError(503,'UNAVAILABLE','公告目录超过处理预算');return {items:rows.map(announcement)};
  });
  app.post('/v1/announcements/:id/dismiss',{preHandler:auth},async req=>{
    fields(req.body,['version']);const row=await store.get('SELECT * FROM announcements WHERE id=?',req.params.id);if(!row)missing();if(req.body.version!==row.version)conflict();
    await store.run('INSERT OR IGNORE INTO announcement_dismissals(user_id,announcement_id,version,created_at) VALUES(?,?,?,?)',req.auth.user_id,row.id,row.version,Date.now());return {id:row.id,version:row.version,dismissed:true};
  });
}
