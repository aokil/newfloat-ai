import {createHash} from 'node:crypto';
import OpenApi from '@alicloud/openapi-client';
import TeaUtil from '@alicloud/tea-util';
import {ApiError,phoneNumber} from './security.js';

const unavailable=()=>new ApiError(503,'SMS_UNAVAILABLE','短信验证暂不可用，请重新获取验证码');
const invalid=()=>new ApiError(422,'VALIDATION_FAILED','验证码无效或过期');
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const token=value=>typeof value==='string'&&value.length>0&&value.length<=8192&&!/[\s\u0000-\u001f\u007f]/u.test(value);
const text=(value,max)=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()&&!/[\u0000-\u001f\u007f]/u.test(value);
const digest=value=>createHash('sha256').update(value).digest('hex');

/** Official generic Alibaba Cloud OpenAPI SDK; no local OTP generation or signing implementation. */
export function configuredAliyunPnvsPhone(env=process.env,{clientFactory}={}) {
  if(env.SMS_PROVIDER!=='aliyun_pnvs')return null;
  const id=env.ALIYUN_ACCESS_KEY_ID,secret=env.ALIYUN_ACCESS_KEY_SECRET,session=env.ALIYUN_SECURITY_TOKEN;
  const sign=env.ALIYUN_PNVS_SIGN_NAME,template=env.ALIYUN_PNVS_TEMPLATE_CODE,scheme=env.ALIYUN_PNVS_SCHEME_NAME||'';
  if(!token(id)||!token(secret)||(session&&!token(session))||!text(sign,100)||!text(template,100)||(scheme&&!text(scheme,20)))return null;
  const config=new OpenApi.Config({accessKeyId:id,accessKeySecret:secret,securityToken:session||undefined,
    endpoint:'dypnsapi.aliyuncs.com',protocol:'HTTPS'});
  const client=clientFactory?clientFactory(config):new OpenApi.default(config);
  const issuer=`aliyun-pnvs:${digest(`${id}\n${scheme}`)}`;
  async function call(action,query) {
    try {
      const params=new OpenApi.Params({action,version:'2017-05-25',protocol:'HTTPS',pathname:'/',method:'POST',
        authType:'AK',style:'RPC',reqBodyType:'formData',bodyType:'json'});
      const request=new OpenApi.OpenApiRequest({query});
      const runtime=new TeaUtil.RuntimeOptions({autoretry:false,maxAttempts:1,connectTimeout:5000,readTimeout:5000});
      const result=await client.callApi(params,request,runtime);
      const body=result?.body;
      if(!record(body)||body.Code!=='OK'||body.Success!==true||!record(body.Model))throw unavailable();
      return body.Model;
    } catch {throw unavailable();} // Never expose provider responses, credentials, or OTP parameters.
  }
  function input(phone,challengeId) {
    const normalized=phoneNumber(phone);
    if(!text(challengeId,128))throw unavailable();
    return {normalized,query:{PhoneNumber:normalized.slice(3),CountryCode:'86',OutId:challengeId,...(scheme?{SchemeName:scheme}:{})}};
  }
  return {
    provider:'aliyun_pnvs',issuer,
    async send({phone,challengeId}) {
      const {query}=input(phone,challengeId);
      const model=await call('SendSmsVerifyCode',{...query,SignName:sign,TemplateCode:template,
        TemplateParam:JSON.stringify({code:'##code##',min:'5'}),CodeLength:'6',CodeType:'1',ValidTime:'300',
        DuplicatePolicy:'1',Interval:'60',ReturnVerifyCode:'false'});
      if(model.OutId!==challengeId)throw unavailable();
    },
    async verify({phone,code,challengeId}) {
      if(typeof code!=='string'||!/^\d{6}$/u.test(code))throw invalid();
      const {normalized,query}=input(phone,challengeId);
      const model=await call('CheckSmsVerifyCode',{...query,VerifyCode:code});
      if(model.OutId!==challengeId)throw unavailable();
      if(model.VerifyResult!=='PASS') {
        if(model.VerifyResult==='UNKNOWN')throw invalid();
        throw unavailable();
      }
      return Object.freeze({issuer,subject:digest(normalized),phone:normalized});
    }
  };
}
