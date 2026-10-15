import {ApiError,fields,text,id,sha256} from './security.js';

const initialRows=[{id:'chatgpt-plus',category:'ChatGPT Plus 会员直充',price:'135/月'}];
// Existing plain-text feedback remains readable. The prefix cannot occur in accepted user text.
const contactEnvelope='\u001econtact-v1:';
function feedbackContent(body){
  if(!body.startsWith(contactEnvelope))return {message:body,contact:''};
  try {
    const value=JSON.parse(body.slice(contactEnvelope.length));
    if(typeof value.message!=='string'||value.message.length<1||value.message.length>2000||typeof value.contact!=='string'||value.contact.length>200)throw new Error();
    return {message:value.message,contact:value.contact};
  } catch {throw new ApiError(500,'INVALID_FEEDBACK_STORAGE','反馈记录读取失败');}
}
function promotionRows(raw){
  if(!Array.isArray(raw)||raw.length>50)throw new ApiError(400,'INVALID_REQUEST','推广表格最多50行');
  const seen=new Set();
  return raw.map(value=>{
    fields(value,['id','category','price']);
    const row={id:text(value.id,'id',1,80).trim(),category:text(value.category,'类目',1,120).trim(),price:text(value.price,'价格',1,60).trim()};
    if(!/^[a-zA-Z0-9_-]+$/u.test(row.id)||[row.category,row.price].some(value=>/[\u0000-\u001f\u007f]/u.test(value)))throw new ApiError(400,'INVALID_REQUEST','推广内容包含无效字符');
    if(seen.has(row.id))throw new ApiError(400,'INVALID_REQUEST','推广项目编号重复');
    seen.add(row.id);return row;
  });
}
export function communityRoutes(app,{store,auth,admin,idem,integer}){
  const published=async()=>{
    const row=await store.get("SELECT * FROM app_promotions WHERE id='main'");
    return row?{revision:row.revision,rows:JSON.parse(row.content),updatedAt:row.updated_at}:{revision:0,rows:initialRows,updatedAt:null};
  };
  app.get('/v1/promotions',async()=>published());
  app.get('/v1/admin/promotions',{preHandler:admin},async()=>published());
  app.put('/v1/admin/promotions',{preHandler:admin},async req=>{
    fields(req.body,['rows','expectedRevision']);
    const rows=promotionRows(req.body.rows);
    if(!Number.isSafeInteger(req.body.expectedRevision)||req.body.expectedRevision<0)throw new ApiError(400,'INVALID_REQUEST','推广版本无效');
    return idem(req,sha256(JSON.stringify(req.body)),async()=>{
      const old=await published();
      if(old.revision!==req.body.expectedRevision)throw new ApiError(409,'VERSION_CONFLICT','推广内容已更新，请重新读取后编辑');
      const now=Date.now();
      if(old.revision===0)await store.run('INSERT INTO app_promotions(id,revision,content,updated_at,updated_by) VALUES(?,?,?,?,?)','main',1,JSON.stringify(rows),now,req.auth.user_id);
      else await store.run("UPDATE app_promotions SET revision=revision+1,content=?,updated_at=?,updated_by=? WHERE id='main'",JSON.stringify(rows),now,req.auth.user_id);
      await store.audit(req.auth.user_id,'publish-promotions','main',{revision:old.revision+1,rowCount:rows.length});
      return published();
    });
  });
  app.post('/v1/feedback',{preHandler:auth},async req=>{
    fields(req.body,['message','contact']);const message=text(req.body.message,'反馈内容',1,2000).trim();
    const contact=req.body.contact===undefined?'':text(req.body.contact,'联系方式',0,200).trim();
    if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(message))throw new ApiError(400,'INVALID_REQUEST','反馈内容包含无效字符');
    if(/[\u0000-\u001f\u007f]/u.test(contact))throw new ApiError(400,'INVALID_REQUEST','联系方式包含无效字符');
    return idem(req,sha256(JSON.stringify(contact?{message,contact}:{message})),async()=>{
      const feedbackId=id('feedback'),createdAt=Date.now();
      const stored=contact?contactEnvelope+JSON.stringify({message,contact}):message;
      await store.run('INSERT INTO user_feedback(id,user_id,body,created_at) VALUES(?,?,?,?)',feedbackId,req.auth.user_id,stored,createdAt);
      return {feedbackId,createdAt,status:'received'};
    });
  });
  app.get('/v1/admin/feedback',{preHandler:admin},async req=>{
    const limit=integer(req.query.limit,30,1,100),offset=integer(req.query.cursor,0,0,100000000);
    const rows=await store.all('SELECT f.*,u.display_name FROM user_feedback f JOIN users u ON u.id=f.user_id ORDER BY f.created_at DESC,f.id DESC LIMIT ? OFFSET ?',limit+1,offset);
    return {items:rows.slice(0,limit).map(row=>({id:row.id,userId:row.user_id,displayName:row.display_name,...feedbackContent(row.body),createdAt:row.created_at})),nextCursor:rows.length>limit?String(offset+limit):null};
  });
}
