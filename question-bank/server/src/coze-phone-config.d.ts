export type CozePhoneProvider = 'supabase' | 'aliyun_pnvs';
export const ALIYUN_PHONE_FIELDS: readonly string[];
export const COZE_PHONE_BINDING_NAMES: readonly string[];
export function cozePhoneProvider(env?: Readonly<Record<string,string|undefined>>): CozePhoneProvider;
export function cozePhoneEnvironment(env?: Readonly<Record<string,string|undefined>>): Readonly<Record<string,string|undefined>>;
