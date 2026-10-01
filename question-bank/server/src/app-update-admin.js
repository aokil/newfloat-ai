import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {activateAppUpdate,inspectApk,prepareAppUpdate} from './app-updates.js';

function args(values) {
  const command=values[0],result={};
  for(let i=1;i<values.length;i+=2){const key=values[i],value=values[i+1];if(!key?.startsWith('--')||value===undefined||result[key])throw new Error('参数格式无效');result[key]=value;}
  return {command,result};
}
const {command,result}=args(process.argv.slice(2));
if(!['inspect','prepare','activate','publish'].includes(command))throw new Error('用法: app-update <inspect|prepare|activate|publish> [--directory DIR] [--apk APK --notes-file FILE | --release-id SHA256]');
const allowed=command==='inspect'?['--apk']:command==='activate'?['--directory','--release-id']:['--directory','--apk','--notes-file'];
if(Object.keys(result).some(key=>!allowed.includes(key)))throw new Error('参数含未知字段');
let output;
if(command==='inspect'){
  if(!result['--apk'])throw new Error('inspect需要apk');
  output={status:'inspected',apk:await inspectApk(resolve(result['--apk']))};
} else {
  if(!result['--directory'])throw new Error('缺少directory');const directory=resolve(result['--directory']);let release;
  if(command==='activate')release=await activateAppUpdate({directory,releaseId:result['--release-id']});
  else {
    if(!result['--apk']||!result['--notes-file'])throw new Error('prepare/publish需要apk和notes-file');
    const notes=await readFile(resolve(result['--notes-file']),'utf8');release=await prepareAppUpdate({directory,apkPath:resolve(result['--apk']),notes:notes.replace(/\r?\n$/u,'')});
    if(command==='publish')release=await activateAppUpdate({directory,releaseId:release.releaseId});
  }
  output={status:command==='prepare'?'prepared':'published',release};
}
process.stdout.write(JSON.stringify(output,null,2)+'\n');
