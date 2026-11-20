/** Only the server's current phase selects a provider. HTTP bodies cannot select SMS credentials. */
export const ALIYUN_PHONE_FIELDS=Object.freeze(['ALIYUN_ACCESS_KEY_ID','ALIYUN_ACCESS_KEY_SECRET','ALIYUN_SECURITY_TOKEN',
  'ALIYUN_PNVS_SIGN_NAME','ALIYUN_PNVS_TEMPLATE_CODE','ALIYUN_PNVS_SCHEME_NAME']);
export const COZE_PHONE_BINDING_NAMES=Object.freeze(['DEV','PROD'].flatMap(phase=>
  [`SMS_PROVIDER_${phase}`,...ALIYUN_PHONE_FIELDS.map(name=>`${name}_${phase}`)]));
export function cozePhoneProvider(env=process.env) {
  const value=env[`SMS_PROVIDER_${env.COZE_PROJECT_ENV}`]?.trim()||'supabase';
  if(!['supabase','aliyun_pnvs'].includes(value))throw new Error('COZE_SMS_PROVIDER_INVALID');
  return value;
}
export function cozePhoneEnvironment(env=process.env) {
  const result={SMS_PROVIDER:cozePhoneProvider(env)};
  for(const name of ALIYUN_PHONE_FIELDS)result[name]=env[`${name}_${env.COZE_PROJECT_ENV}`];
  return Object.freeze(result);
}
