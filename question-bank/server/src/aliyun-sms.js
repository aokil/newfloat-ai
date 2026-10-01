import Dysms from '@alicloud/dysmsapi20170525';
import OpenApi from '@alicloud/openapi-client';
import TeaUtil from '@alicloud/tea-util';

/** Optional transport only. Challenge/identity/billing rules stay in our backend. */
export function configuredSmsTransport(env=process.env) {
  if(env.SMS_PROVIDER!=='aliyun')return null;
  const required=['ALIYUN_ACCESS_KEY_ID','ALIYUN_ACCESS_KEY_SECRET','ALIYUN_SMS_SIGN_NAME','ALIYUN_SMS_TEMPLATE_CODE'];
  if(required.some(name=>!env[name]))return null;
  const client=new Dysms.default(new OpenApi.Config({accessKeyId:env.ALIYUN_ACCESS_KEY_ID,accessKeySecret:env.ALIYUN_ACCESS_KEY_SECRET,
    securityToken:env.ALIYUN_SECURITY_TOKEN||undefined,endpoint:'dysmsapi.aliyuncs.com',protocol:'HTTPS'}));
  return {async send({phone,code}) {
    if(!/^\+861[3-9]\d{9}$/u.test(phone))throw new Error('UNSUPPORTED_PHONE');
    const request=new Dysms.SendSmsRequest({phoneNumbers:phone.slice(3),signName:env.ALIYUN_SMS_SIGN_NAME,templateCode:env.ALIYUN_SMS_TEMPLATE_CODE,templateParam:JSON.stringify({code})});
    const response=await client.sendSmsWithOptions(request,new TeaUtil.RuntimeOptions({autoretry:false,maxAttempts:1,connectTimeout:5000,readTimeout:5000}));
    if(response.body?.code!=='OK')throw new Error('SMS_PROVIDER_REJECTED');
  }};
}
