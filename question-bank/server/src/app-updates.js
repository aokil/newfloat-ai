import {createHash,randomUUID} from 'node:crypto';
import {constants as fsConstants,createReadStream} from 'node:fs';
import {access,chmod,copyFile,lstat,mkdir,open,readFile,realpath,rename,rm,stat,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve,sep} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {ApiError} from './security.js';

export const APP_PACKAGE='com.newfloat.floating';
export const PART_SIZE=4*1024*1024;
export const APK_LIMIT=96*1024*1024;
const MANIFEST_LIMIT=32*1024;
const HASH=/^[0-9a-f]{64}$/u;
const execFileAsync=promisify(execFile);
const verifiedApks=new Map();
const unavailable=message=>{throw new ApiError(503,'UNAVAILABLE',message);};
const notFound=()=>{throw new ApiError(404,'NOT_FOUND','未找到已发布的安装包分片');};
async function hashFile(path,start,end) {
  const hash=createHash('sha256');
  for await(const chunk of createReadStream(path,{...(start===undefined?{}:{start,end})}))hash.update(chunk);
  return hash.digest('hex');
}
async function regular(path,message) {
  let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')return null;unavailable(message);}
  if(!info.isFile()||info.isSymbolicLink())unavailable(message);return info;
}
function manifestError(message='客户端更新发布目录损坏') { unavailable(message); }
const fingerprint=info=>`${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
function validateManifest(value,releaseId) {
  if(!value||typeof value!=='object'||Array.isArray(value))manifestError();
  const keys=['releaseId','packageName','versionCode','versionName','minSdk','sizeBytes','sha256','signerSha256','publishedAt','notes','parts'];
  if(Object.keys(value).some(key=>!keys.includes(key))||keys.some(key=>!(key in value)))manifestError();
  if(!HASH.test(releaseId)||value.releaseId!==releaseId||value.sha256!==releaseId||!HASH.test(value.signerSha256))manifestError();
  if(value.packageName!==APP_PACKAGE||!Number.isSafeInteger(value.versionCode)||value.versionCode<=0||typeof value.versionName!=='string'||!value.versionName.length||value.versionName.length>128)manifestError();
  if(!Number.isSafeInteger(value.minSdk)||value.minSdk<=0||!Number.isSafeInteger(value.sizeBytes)||value.sizeBytes<1||value.sizeBytes>APK_LIMIT)manifestError();
  let publishedAt;try{publishedAt=typeof value.publishedAt==='string'?new Date(value.publishedAt).toISOString():null;}catch{manifestError();}
  if(typeof value.notes!=='string'||value.notes.length>2000||publishedAt!==value.publishedAt)manifestError();
  if(!Array.isArray(value.parts)||!value.parts.length||value.parts.length>24||value.parts.length!==Math.ceil(value.sizeBytes/PART_SIZE))manifestError();
  let total=0;
  for(let index=0;index<value.parts.length;index++){
    const part=value.parts[index],expected=index===value.parts.length-1?value.sizeBytes-index*PART_SIZE:PART_SIZE;
    if(!part||typeof part!=='object'||Array.isArray(part)||Object.keys(part).some(key=>!['index','sizeBytes','sha256','path'].includes(key))||
      part.index!==index||part.sizeBytes!==expected||!HASH.test(part.sha256)||part.path!==`/v1/app-updates/android/packages/${releaseId}/parts/${index}`)manifestError();
    total+=part.sizeBytes;
  }
  if(total!==value.sizeBytes||Buffer.byteLength(JSON.stringify(value))>MANIFEST_LIMIT)manifestError();
  return value;
}
async function rootPath(directory) {
  const configured=resolve(directory);let found;
  try{found=await realpath(configured);}catch(error){if(error.code==='ENOENT')return null;unavailable('客户端更新发布目录不可读');}
  const info=await lstat(found).catch(()=>null);if(!info?.isDirectory())unavailable('客户端更新发布目录无效');return found;
}
function child(root,...segments) {
  const path=resolve(root,...segments);if(path!==root&&!path.startsWith(root+sep))manifestError();return path;
}
export async function loadRelease(directory,releaseId,{whole=false}={}) {
  if(!HASH.test(releaseId))notFound();const root=await rootPath(directory);if(!root)notFound();
  const releaseDirectory=child(root,'releases',releaseId),manifestPath=child(releaseDirectory,'manifest.json'),apkPath=child(releaseDirectory,'app.apk');
  let releaseInfo;try{releaseInfo=await lstat(releaseDirectory);}catch(error){if(error.code==='ENOENT')notFound();unavailable('客户端更新发布目录不可读');}
  if(!releaseInfo.isDirectory()||releaseInfo.isSymbolicLink())manifestError();
  const manifestInfo=await regular(manifestPath,'客户端更新清单缺失或不可读');if(!manifestInfo||manifestInfo.size>MANIFEST_LIMIT)manifestError();
  let parsed;try{parsed=JSON.parse(await readFile(manifestPath,'utf8'));}catch{manifestError();}
  const manifest=validateManifest(parsed,releaseId),apkInfo=await regular(apkPath,'客户端更新安装包缺失或不可读');
  if(!apkInfo||apkInfo.size!==manifest.sizeBytes)manifestError();
  if(whole){
    const key=`${apkPath}\n${releaseId}`,before=`${fingerprint(apkInfo)}|${fingerprint(manifestInfo)}`;
    if(verifiedApks.get(key)!==before){
      if(await hashFile(apkPath)!==releaseId)manifestError('客户端更新安装包完整性校验失败');
      for(const part of manifest.parts){const start=part.index*PART_SIZE;if(await hashFile(apkPath,start,start+part.sizeBytes-1)!==part.sha256)manifestError('客户端更新分片清单校验失败');}
      const [afterApk,afterManifest]=await Promise.all([regular(apkPath,'客户端更新安装包缺失或不可读'),regular(manifestPath,'客户端更新清单缺失或不可读')]);
      if(!afterApk||!afterManifest||`${fingerprint(afterApk)}|${fingerprint(afterManifest)}`!==before)manifestError('客户端更新发布内容在校验期间发生变化');
      verifiedApks.set(key,before);while(verifiedApks.size>32)verifiedApks.delete(verifiedApks.keys().next().value);
    }
  }
  return {manifest,apkPath};
}
export async function latestRelease(directory) {
  if(!directory)return null;const root=await rootPath(directory);if(!root)return null;
  const latestPath=child(root,'latest.json'),info=await regular(latestPath,'客户端更新latest清单不可读');if(!info)return null;
  if(info.size>1024)manifestError();let latest;try{latest=JSON.parse(await readFile(latestPath,'utf8'));}catch{manifestError();}
  if(!latest||Object.keys(latest).length!==1||!HASH.test(latest.releaseId))manifestError();
  try{return (await loadRelease(root,latest.releaseId,{whole:true})).manifest;}
  catch(error){if(error instanceof ApiError&&error.statusCode===404)manifestError('客户端更新latest指向不存在的发布');throw error;}
}
export function registerAppUpdateRoutes(app,{directory=null}={}) {
  app.get('/v1/app-updates/android/latest',async()=>{
    const release=await latestRelease(directory);return release?{status:'available',release}:{status:'not_published'};
  });
  app.get('/v1/app-updates/android/packages/:releaseId/parts/:index',async(req,reply)=>{
    if(!directory)notFound();
    const {releaseId,index:raw}=req.params;if(!HASH.test(releaseId)||!/^(0|[1-9]\d*)$/u.test(raw))notFound();
    const index=Number(raw);if(!Number.isSafeInteger(index)||index<0||index>=24)notFound();
    const {manifest,apkPath}=await loadRelease(directory??'',releaseId),part=manifest.parts[index];if(!part)notFound();
    const start=index*PART_SIZE,end=start+part.sizeBytes-1,bytes=await new Promise((resolvePart,reject)=>{
      const chunks=[];let size=0;const stream=createReadStream(apkPath,{start,end});
      stream.on('data',chunk=>{size+=chunk.length;chunks.push(chunk);});stream.on('error',reject);stream.on('end',()=>resolvePart(Buffer.concat(chunks,size)));
    }).catch(()=>unavailable('客户端更新分片读取失败'));
    if(bytes.length!==part.sizeBytes||createHash('sha256').update(bytes).digest('hex')!==part.sha256)manifestError('客户端更新分片完整性校验失败');
    return reply.type('application/octet-stream').header('Content-Length',String(bytes.length)).send(bytes);
  });
}
function parseBadging(output) {
  const packageLine=output.match(/^package:\s+name='([^']+)'\s+versionCode='(\d+)'\s+versionName='([^']+)'/mu);
  const minSdk=output.match(/^sdkVersion:'(\d+)'/mu);if(!packageLine||!minSdk)throw new Error('aapt未返回完整包名/版本/minSdk');
  return {packageName:packageLine[1],versionCode:Number(packageLine[2]),versionName:packageLine[3],minSdk:Number(minSdk[1])};
}
function sdkTool(name,env=process.env) {
  const extension=process.platform==='win32'?(name==='aapt'?'.exe':'.bat'):'';
  const explicit=env[`ANDROID_${name.toUpperCase()}_PATH`];if(explicit)return resolve(explicit);
  const sdk=env.ANDROID_HOME||env.ANDROID_SDK_ROOT;if(!sdk)throw new Error('缺少ANDROID_HOME/ANDROID_SDK_ROOT');
  const tools=resolve(sdk,'build-tools');
  return {tools,extension};
}
async function newestTool(name,env) {
  const found=sdkTool(name,env);if(typeof found==='string'){await access(found,fsConstants.X_OK);return found;}
  const {readdir}=await import('node:fs/promises');const versions=(await readdir(found.tools,{withFileTypes:true})).filter(item=>item.isDirectory()).map(item=>item.name).sort((a,b)=>b.localeCompare(a,undefined,{numeric:true}));
  for(const version of versions){const path=join(found.tools,version,name+found.extension);try{await access(path,fsConstants.X_OK);return path;}catch{}}
  throw new Error(`Android SDK缺少${name}`);
}
export async function inspectApk(apkPath,{env=process.env,exec=execFileAsync}={}) {
  const aapt=await newestTool('aapt',env),apksigner=await newestTool('apksigner',env);
  const java=env.JAVA_HOME?join(env.JAVA_HOME,'bin',process.platform==='win32'?'java.exe':'java'):'java';
  const signerCommand=process.platform==='win32'&&apksigner.endsWith('.bat')?java:apksigner;
  const signerArgs=signerCommand===apksigner?['verify','--print-certs',apkPath]:['-jar',join(dirname(apksigner),'lib','apksigner.jar'),'verify','--print-certs',apkPath];
  const [{stdout:badging},{stdout:certs}]=await Promise.all([
    exec(aapt,['dump','badging',apkPath],{maxBuffer:1024*1024,windowsHide:true}),
    exec(signerCommand,signerArgs,{maxBuffer:1024*1024,windowsHide:true})
  ]);
  const metadata=parseBadging(badging),digest=certs.match(/Signer #1 certificate SHA-256 digest:\s*([0-9a-f:]{64,95})/iu)?.[1]?.replace(/:/gu,'').toLowerCase();
  if(!digest||!HASH.test(digest))throw new Error('apksigner未返回单签名证书SHA-256');
  if(/Signer #2/iu.test(certs))throw new Error('当前更新协议只允许单签名APK');
  return {...metadata,signerSha256:digest};
}
async function atomicJson(path,value) {
  const temp=join(dirname(path),`.${basename(path)}.${randomUUID()}.tmp`),handle=await open(temp,'wx',0o640);
  try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}
  await rename(temp,path);
}
export async function prepareAppUpdate({directory,apkPath,notes='',inspect=inspectApk,now=()=>new Date()}={}) {
  if(typeof directory!=='string'||!directory||typeof apkPath!=='string'||!apkPath)throw new Error('prepare需要directory和apkPath');
  if(typeof notes!=='string'||notes.length>2000)throw new Error('notes最多2000字符');
  const source=await realpath(resolve(apkPath)),sourceInfo=await lstat(source);if(!sourceInfo.isFile()||sourceInfo.isSymbolicLink())throw new Error('APK必须是可信本地普通文件');
  if(sourceInfo.size<1||sourceInfo.size>APK_LIMIT)throw new Error('APK大小须为1..96MiB');
  const root=resolve(directory);await mkdir(join(root,'releases'),{recursive:true});
  const releaseId=await hashFile(source),releaseDirectory=join(root,'releases',releaseId);
  try{await lstat(releaseDirectory);throw new Error('相同APK发布目录已存在，拒绝覆盖');}catch(error){if(error.code!=='ENOENT')throw error;}
  const stage=join(root,`.staging-${randomUUID()}`);await mkdir(stage,{recursive:false});
  try{
    const target=join(stage,'app.apk');await copyFile(source,target,fsConstants.COPYFILE_EXCL);
    const copied=await stat(target);if(copied.size!==sourceInfo.size||await hashFile(target)!==releaseId)throw new Error('APK复制完整性校验失败');
    const metadata=await inspect(target);if(metadata.packageName!==APP_PACKAGE)throw new Error(`包名必须为${APP_PACKAGE}`);
    if(!Number.isSafeInteger(metadata.versionCode)||metadata.versionCode<=0||typeof metadata.versionName!=='string'||!metadata.versionName.length||metadata.versionName.length>128||!Number.isSafeInteger(metadata.minSdk)||metadata.minSdk<=0||!HASH.test(metadata.signerSha256))throw new Error('APK版本或签名元数据无效');
    const current=await latestRelease(root);if(current&&metadata.versionCode<=current.versionCode)throw new Error('versionCode必须高于当前latest');
    const parts=[];for(let index=0,start=0;start<copied.size;index++,start+=PART_SIZE){const sizeBytes=Math.min(PART_SIZE,copied.size-start);parts.push({index,sizeBytes,sha256:await hashFile(target,start,start+sizeBytes-1),path:`/v1/app-updates/android/packages/${releaseId}/parts/${index}`});}
    const manifest=validateManifest({releaseId,packageName:APP_PACKAGE,versionCode:metadata.versionCode,versionName:metadata.versionName,minSdk:metadata.minSdk,sizeBytes:copied.size,sha256:releaseId,signerSha256:metadata.signerSha256,publishedAt:now().toISOString(),notes,parts},releaseId);
    await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o440});if(process.platform!=='win32')await chmod(target,0o440);
    await rename(stage,releaseDirectory);if(process.platform!=='win32')await chmod(releaseDirectory,0o550);return manifest;
  }catch(error){await rm(stage,{recursive:true,force:true});throw error;}
}
export async function activateAppUpdate({directory,releaseId}={}) {
  if(typeof directory!=='string'||!directory||typeof releaseId!=='string'||!HASH.test(releaseId))throw new Error('activate参数无效');
  const root=await rootPath(directory);if(!root)throw new Error('发布目录不存在');const lockPath=join(root,'.activate.lock');let lock;
  try{lock=await open(lockPath,'wx',0o600);}catch(error){if(error.code==='EEXIST')throw new Error('检测到发布激活锁；可能有并行发布或上次异常退出，须人工核查，不自动夺锁');throw error;}
  try {
    await lock.writeFile(JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()})+'\n');await lock.sync();
    const next=(await loadRelease(root,releaseId,{whole:true})).manifest,current=await latestRelease(root);
    if(current?.releaseId===releaseId)throw new Error('该release已是latest');
    if(current&&next.versionCode<=current.versionCode)throw new Error('versionCode必须高于当前latest');
    await atomicJson(join(root,'latest.json'),{releaseId});return next;
  } finally { await lock.close();await rm(lockPath,{force:true}); }
}
