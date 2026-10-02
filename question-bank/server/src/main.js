import {buildApp} from './app.js';
import {resolve} from 'node:path';
import {configuredSmsTransport} from './aliyun-sms.js';
import {configuredSupabasePhone} from './supabase-phone.js';
import {configuredCozeBridge} from './coze-model-transport.js';
import {configuredAlipayTransport} from './alipay.js';
const host=process.env.HOST||'127.0.0.1';const port=Number(process.env.PORT||8787);
if(!['127.0.0.1','::1','localhost'].includes(host)&&process.env.BEHIND_HTTPS_PROXY!=='true')throw new Error('Non-loopback bind requires BEHIND_HTTPS_PROXY=true and a configured HTTPS reverse proxy');
const app=await buildApp({database:resolve(process.env.BANK_DATABASE||'data/bank.sqlite'),logger:true,
  smsTransport:configuredSmsTransport(),phoneVerifier:configuredSupabasePhone(),smsHmacKey:process.env.SMS_HMAC_KEY||null,modelMasterKey:process.env.MODEL_MASTER_KEY||null,cozeBridge:configuredCozeBridge(),
  paymentTransport:configuredAlipayTransport(),appUpdateDirectory:process.env.APP_UPDATE_DIRECTORY?resolve(process.env.APP_UPDATE_DIRECTORY):null});
await app.listen({host,port});
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await app.close();process.exit(0);});
