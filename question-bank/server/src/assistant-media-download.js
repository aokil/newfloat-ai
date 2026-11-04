import {request} from 'node:https';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {ApiError} from './security.js';

const SUFFIXES=['volces.com','volcengine.com','byteimg.com','coze.cn','coze.com','coze.site'];
function publicAddress(address){
  if(isIP(address)===4){
    const [a,b]=address.split('.').map(Number);
    return !(a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&[0,168].includes(b)||
      a===100&&b>=64&&b<=127||a===198&&[18,19].includes(b)||a>=224);
  }
  if(isIP(address)===6){const lower=new URL('http://['+address+']/').hostname.slice(1,-1).toLowerCase();return lower!=='::'&&lower!=='::1'&&
    !/^(fc|fd|fe[89ab]|ff|::ffff:|2001:db8:)/u.test(lower);}
  return false;
}

/** Provider-returned media only. Pin public DNS addresses and recheck every redirect; never forward credentials. */
export async function assistantMediaDownload(raw,signal,depth=0){
  let url;try{url=new URL(raw);}catch{throw new ApiError(502,'MEDIA_FILE_URL_INVALID','平台返回了无效文件地址');}
  const host=url.hostname.toLowerCase();
  if(depth>3||url.protocol!=='https:'||url.username||url.password||url.hash||url.port&&url.port!=='443'||
    !SUFFIXES.some(suffix=>host===suffix||host.endsWith('.'+suffix)))
    throw new ApiError(502,'MEDIA_FILE_URL_INVALID','媒体文件下载地址不属于已接入平台，未访问');
  const addresses=await lookup(host,{all:true,verbatim:true});
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw new ApiError(502,'MEDIA_FILE_URL_INVALID','媒体下载地址未通过公网检查');
  signal.throwIfAborted();
  const chosen=addresses.find(item=>item.family===4)??addresses[0];
  const response=await new Promise((resolve,reject)=>{
    const outgoing=request(url,{method:'GET',signal,headers:{accept:'image/*,video/mp4,application/octet-stream'},
      lookup:(_host,options,callback)=>options?.all?callback(null,[chosen]):callback(null,chosen.address,chosen.family)},resolve);
    outgoing.setTimeout(30000,()=>outgoing.destroy(new Error('MEDIA_DOWNLOAD_TIMEOUT')));
    outgoing.once('error',reject);outgoing.end();
  });
  if([301,302,303,307,308].includes(response.statusCode)){
    const location=response.headers.location;response.resume();
    if(typeof location!=='string')throw new ApiError(502,'MEDIA_FILE_DOWNLOAD_FAILED','媒体下载重定向缺少目标');
    return assistantMediaDownload(new URL(location,url).toString(),signal,depth+1);
  }
  if(response.statusCode!==200){response.resume();throw new ApiError(502,'MEDIA_FILE_DOWNLOAD_FAILED',
    response.statusCode===403||response.statusCode===404?'平台文件链接已失效或文件不可取回，请查看生成记录':'平台文件下载失败，未登记为已保存');}
  const supplied=String(response.headers['content-type']??'application/octet-stream').split(';')[0].toLowerCase();
  const type=supplied==='image/jpg'||supplied==='image/pjpeg'?'image/jpeg':supplied==='application/mp4'?'video/mp4':supplied;
  if(!['image/jpeg','image/png','image/webp','video/mp4','application/octet-stream'].includes(type)){
    response.destroy();throw new ApiError(502,'MEDIA_FILE_FORMAT_INVALID','平台下载内容不是已支持的实际图片或MP4视频');
  }
  return {stream:response,mimeType:type,length:response.headers['content-length']};
}
