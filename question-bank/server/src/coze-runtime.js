import {createHmac} from 'node:crypto';
import {buildApp} from './app.js';
import {PostgresStore} from './postgres-store.js';
import {configuredSupabasePhone} from './supabase-phone.js';
import {configuredAlipayTransport} from './alipay.js';

/** Native Coze entry; credentials arrive in memory from the platform SDK. */
export async function createCozeApp({databaseUrl,phoneConfiguration,cozeBridge,env=process.env}) {
  // Bind configuration before the first await. Platform environment changes
  // cannot switch an in-flight initialization to another payment merchant.
  env=Object.freeze({...env});
  if (env.COZE_PROJECT_ID !== '7689833705046130729' || !['DEV','PROD'].includes(env.COZE_PROJECT_ENV))
    throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
  if (typeof databaseUrl !== 'string' || !databaseUrl) throw new Error('COZE_DATABASE_UNAVAILABLE');
  const gatewayKey=env.TIYU_GATEWAY_KEY;
  if (typeof gatewayKey !== 'string' || gatewayKey.length<32 || gatewayKey.length>512)
    throw new Error('COZE_RUNTIME_KEY_UNAVAILABLE');
  const derive=context=>createHmac('sha256',gatewayKey).update(context).digest();
  const paymentTransport=configuredAlipayTransport(env);
  const phoneVerifier=configuredSupabasePhone({SMS_PROVIDER:'supabase',
    SUPABASE_URL:phoneConfiguration?.supabaseUrl || env.COZE_SUPABASE_URL,
    SUPABASE_ANON_KEY:phoneConfiguration?.anonKey || env.COZE_SUPABASE_ANON_KEY});
  const store=await PostgresStore.open({connectionString:databaseUrl,schema:'float_ai',max:5,
    application_name:`float-ai-${env.COZE_PROJECT_ENV.toLowerCase()}`,statement_timeout:15000});
  try {
    const app=await buildApp({store,phoneVerifier,cozeBridge,paymentTransport,
      smsHmacKey:derive('float-ai/sms-proof/v1').toString('hex'),
      modelMasterKey:env.MODEL_MASTER_KEY || derive('float-ai/model-key/v1').toString('base64'),
      bootstrapAdminPhone:env.BOOTSTRAP_ADMIN_PHONE || null,trustProxy:1});
    app.decorate('phoneReady',Boolean(phoneVerifier));
    await app.ready();
    return app;
  } catch (error) {await store.close(); throw error;}
}
