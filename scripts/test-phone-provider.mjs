import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as workloadModule from '../src/lib/coze-workload.server.ts';
const {acceptProductionInjectedResources,getInjectedProjectResources,workloadRuntimeStatus}=workloadModule.default||workloadModule;

test('phone credentials remain process-bound while the admin selection is stored separately',()=>{
  const values={COZE_PROJECT_ID:'7689833705046130729',COZE_PROJECT_ENV:'PROD',
    COZE_WORKLOAD_IDENTITY_API_KEY:'synthetic-owner-token',COZE_API_TOKEN:'synthetic-owner-token',
    COZE_WORKLOAD_IDENTITY_CLIENT_ID:'synthetic-client',COZE_WORKLOAD_IDENTITY_CLIENT_SECRET:'synthetic-secret',
    COZE_WORKLOAD_IDENTITY_TOKEN_ENDPOINT:'https://synthetic.invalid/token',
    COZE_WORKLOAD_ACCESS_TOKEN_ENDPOINT:'https://synthetic.invalid/access',COZE_OUTBOUND_AUTH_ENDPOINT:'https://synthetic.invalid/auth',
    PGDATABASE_URL_PROD:'postgresql://synthetic:unused@database.invalid/synthetic?sslmode=require',
    TIYU_SUPABASE_URL_PROD:undefined,TIYU_SUPABASE_ANON_KEY_PROD:undefined,SMS_PROVIDER_PROD:'aliyun_pnvs',
    ALIYUN_ACCESS_KEY_ID_PROD:'synthetic-id',ALIYUN_ACCESS_KEY_SECRET_PROD:'synthetic-secret'};
  const before=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  const originalFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No external service in config regression');};
  try {
    for(const [name,value] of Object.entries(values))if(value===undefined)delete process.env[name];else process.env[name]=value;
    assert(getInjectedProjectResources().databaseUrl);assert.equal(getInjectedProjectResources().phoneConfiguration,undefined);
    assert.equal(acceptProductionInjectedResources(),true);
    process.env.ALIYUN_ACCESS_KEY_SECRET_PROD='changed-secret';assert.equal(acceptProductionInjectedResources(),false);
    process.env.ALIYUN_ACCESS_KEY_SECRET_PROD=values.ALIYUN_ACCESS_KEY_SECRET_PROD;
    assert.equal(acceptProductionInjectedResources(),true);
    process.env.SMS_PROVIDER_PROD='supabase';assert.equal(acceptProductionInjectedResources(),false);
    process.env.SMS_PROVIDER_PROD='aliyun_pnvs';assert.equal(acceptProductionInjectedResources(),true);
    process.env.SMS_PROVIDER_PROD='unsupported';assert.equal(acceptProductionInjectedResources(),false);
    assert.equal(workloadRuntimeStatus().productionConfigurationAccepted,false);
  } finally {
    globalThis.fetch=originalFetch;
    for(const [name,value] of Object.entries(before))if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
});
