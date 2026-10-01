// Run on the existing account server. Metadata only: this never generates model output.
// Defaults to a read-only check. --write creates a separate file and never replaces a live config.
import {readFile,writeFile,link,unlink} from 'node:fs/promises';
import {createHash,createHmac,randomBytes} from 'node:crypto';

const projectId='7689833705046130729';
const production='https://d635c6m6jj.coze.site';
const preview='https://cf9706dd-b534-450f-abf6-39b2858e5836.dev.coze.site';
const path='/internal/model-completion';
const target='/etc/tiyu/coze-models.env',temporary=target+'.pending';
const args=process.argv.slice(2),write=args.includes('--write'),dev=args.includes('--dev');
const fail=code=>{const error=new Error(code);error.safeCode=code;throw error;};
let staged=false;

try{
  if(args.some(arg=>!['--check','--write','--dev'].includes(arg))||(write&&dev)||(write&&args.includes('--check')))fail('INVALID_OPERATION');
  const lines=(await readFile('/etc/tiyu/edge.env','utf8')).split(/\r?\n/u);
  const gateway=lines.find(line=>line.startsWith('TIYU_GATEWAY_KEY='))?.slice('TIYU_GATEWAY_KEY='.length);
  if(!gateway||!/^[\x21-\x7e]{32,512}$/u.test(gateway))fail('GATEWAY_KEY_MISSING');
  const key=createHmac('sha256',gateway).update('float-ai/coze-llm-bridge/v1').digest('hex');
  const timestamp=String(Date.now()),nonce=randomBytes(16).toString('hex');
  const signature=createHmac('sha256',key).update(`GET\n${path}\n${timestamp}\n${nonce}\n${createHash('sha256').update('').digest('hex')}`).digest('hex');
  const origin=dev?preview:production,environment=dev?'DEV':'PROD';
  const response=await fetch(origin+path,{headers:{accept:'application/json','x-float-llm-timestamp':timestamp,
    'x-float-llm-nonce':nonce,'x-float-llm-signature':signature},redirect:'error',signal:AbortSignal.timeout(22000)});
  if(response.status!==200)fail('METADATA_HTTP_'+response.status);
  if(!response.headers.get('cache-control')?.includes('no-store')||!response.body)fail('METADATA_POLICY_INVALID');
  const reader=response.body.getReader(),parts=[];let size=0;
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;
    if(size>128*1024){await reader.cancel();fail('METADATA_TOO_LARGE');}parts.push(value);}}
  finally{reader.releaseLock();}
  const raw=Buffer.concat(parts).toString('utf8');if(raw.includes(key)||raw.includes(gateway))fail('METADATA_POLICY_INVALID');
  const metadata=JSON.parse(raw);
  if(metadata.projectId!==projectId||metadata.environment!==environment)fail('PROJECT_OR_ENVIRONMENT_MISMATCH');
  if(!Array.isArray(metadata.items)||!metadata.items.length||metadata.items.length>1000||metadata.items.some(item=>
    !item||typeof item.model_id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/u.test(item.model_id)))fail('MODELS_INVALID');
  if(write){
    await writeFile(temporary,`COZE_LLM_ORIGIN=${origin}\nCOZE_LLM_ENVIRONMENT=PROD\nTIYU_LLM_BRIDGE_KEY=${key}\n`,{mode:0o600,flag:'wx'});
    staged=true;await link(temporary,target);await unlink(temporary);staged=false;
  }
  console.log(JSON.stringify({success:true,projectMatches:true,environment,saved:write,generationCalled:false,
    items:metadata.items.map(item=>({modelId:item.model_id,name:item.show_name||item.model_name||item.model_id}))}));
}catch(error){
  if(staged)await unlink(temporary).catch(()=>{});
  console.error(JSON.stringify({success:false,code:error.safeCode||'COZE_MODEL_CONFIGURATION_FAILED'}));process.exitCode=1;
}
