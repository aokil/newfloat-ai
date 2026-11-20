import test from 'node:test';
import assert from 'node:assert/strict';
import {testApp,register,auth,call} from './helpers.js';
import {sha256} from '../src/security.js';
import {lockCloudLibraryOwner,requireCloudLibraryCapacity} from '../src/library-capacity.js';
const question={questionType:'true_false',stem:'合成容量题',options:[],answerText:'正确',answerBoolean:true,answerOptionIds:[],answerComplete:true,explanation:'',sourceName:'capacity-fixture'};
async function seed(app,owner,n,id='seed'){
  const version=id+'-version',questions=Array.from({length:n},(_,i)=>({...question,questionId:'q_'+i,bankId:id,dataVersion:version}));
  const payload=JSON.stringify({schemaVersion:2,normalizationVersion:'text-v1',bankId:id,title:'合成存量',description:'',visibility:'private',ownerUserId:owner,dataVersion:version,releaseSequence:1,questions});
  await app.store.run('INSERT INTO banks(id,owner_id,title,current_version,sequence,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',id,owner,'合成存量',version,1,1,1);
  await app.store.run('INSERT INTO private_versions(bank_id,data_version,sequence,payload,sha256,size_bytes,question_count,created_at) VALUES(?,?,?,?,?,?,?,?)',id,version,1,payload,sha256(payload),Buffer.byteLength(payload),n,1);
  return {id,version};
}
async function upload(app,token,key){const boundary='capacity-boundary';const response=await app.inject({method:'POST',url:'/v1/imports',headers:{...auth(token),'idempotency-key':key,'content-type':`multipart/form-data; boundary=${boundary}`},payload:Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="q.json"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify([question])}\r\n--${boundary}--\r\n`)});assert.equal(response.statusCode,202,response.body);assert.equal(response.json().status,'ready');return response.json().importId;}
test('cloud account aggregate serializes competing imports and replay never consumes capacity twice',async t=>{
  const app=await testApp();t.after(()=>app.close());const u=await register(app,'capacity-one');await seed(app,u.principal.userId,9999);
  const first=await upload(app,u.accessToken,'upload1'),second=await upload(app,u.accessToken,'upload2');
  const responses=await Promise.all([first,second].map((id,i)=>call(app,'POST',`/v1/imports/${id}/confirm`,u.accessToken,{expectedRevision:1},'confirm'+i)));
  assert.deepEqual(responses.map(r=>r.statusCode).sort(),[200,422]);const winner=responses.findIndex(r=>r.statusCode===200),loser=1-winner;
  const denied=responses[loser].json();assert.equal(denied.error.code,'LIBRARY_CAPACITY_EXCEEDED');
  assert.match(denied.error.message,/云端私人题库共10000题/u);
  const ids=[first,second];assert.deepEqual((await call(app,'POST',`/v1/imports/${ids[winner]}/confirm`,u.accessToken,{expectedRevision:1},'confirm'+winner)).json(),responses[winner].json());
  const saved=responses[winner].json();assert.equal((await call(app,'DELETE',`/v1/banks/${saved.bankId}`,u.accessToken,{expectedBankVersion:saved.dataVersion},'delete')).statusCode,200);
  assert.equal((await call(app,'POST',`/v1/imports/${ids[loser]}/confirm`,u.accessToken,{expectedRevision:1},'confirm'+loser)).statusCode,200);
});
test('over-capacity existing libraries remain editable and replaceable with fewer rows but cannot grow',async t=>{
  const app=await testApp();t.after(()=>app.close());const u=await register(app,'capacity-existing'),bank=await seed(app,u.principal.userId,10001);
  const grow=await call(app,'POST',`/v1/banks/${bank.id}/questions`,u.accessToken,{expectedBankVersion:bank.version,question},'grow');assert.equal(grow.statusCode,422);assert.equal(grow.json().error.code,'LIBRARY_CAPACITY_EXCEEDED');
  const edit=await call(app,'PATCH',`/v1/banks/${bank.id}/questions/q_0`,u.accessToken,{expectedBankVersion:bank.version,question:{...question,stem:'修改但不增加数量'}},'edit');assert.equal(edit.statusCode,200,edit.body);assert.equal(edit.json().questionCount,10001);
  const imported=await upload(app,u.accessToken,'replace-upload');const replacement=await call(app,'POST',`/v1/imports/${imported}/confirm`,u.accessToken,{expectedRevision:1,bankId:bank.id,expectedBankVersion:edit.json().dataVersion},'replace');assert.equal(replacement.statusCode,200,replacement.body);
  const current=await app.store.transaction(async()=>{await lockCloudLibraryOwner(app.store,u.principal.userId);return requireCloudLibraryCapacity(app.store,u.principal.userId,null,0);});
  assert.equal(current.used,1);assert.equal(current.libraryCapacity,10000); // old private_versions are not current admission.
});
test('owner isolation and deleted libraries are excluded from current cloud capacity',async t=>{
  const app=await testApp();t.after(()=>app.close());const a=await register(app,'cap-a'),b=await register(app,'cap-b');
  await seed(app,a.principal.userId,10000,'a');await seed(app,b.principal.userId,1,'b');
  const measured=await app.store.transaction(async()=>{await lockCloudLibraryOwner(app.store,b.principal.userId);return requireCloudLibraryCapacity(app.store,b.principal.userId,null,1);});assert.equal(measured.used,1);
  await app.store.run('UPDATE banks SET deleted_at=? WHERE id=?',1,'a');
  const deleted=await app.store.transaction(async()=>{await lockCloudLibraryOwner(app.store,a.principal.userId);return requireCloudLibraryCapacity(app.store,a.principal.userId,null,10000);});assert.equal(deleted.used,0);
});
test('PostgreSQL write guard requests an owner row lock before the aggregate read',async()=>{
  let seen='';await lockCloudLibraryOwner({kind:'postgres',get:async sql=>{seen=sql;return{id:'u'};}},'u');assert.match(seen,/FOR UPDATE$/u);
});
