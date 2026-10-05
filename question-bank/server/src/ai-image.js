import {createHash} from 'node:crypto';
import {ApiError} from './security.js';

export const AI_IMAGE_LIMIT=1024*1024;
// Exact IDs verified against official model documentation, never product names/prices.
const DOCUMENTED_IMAGE_MODELS=new Set([
  'doubao-seed-2-0-pro-260215','doubao-seed-2-0-lite-260215','doubao-seed-2-0-mini-260215',
  'qwen-3-5-plus-260215','qwen3.5-plus','qwen3.5-plus-2026-02-15'
]);
export function modelSupportsImages(modelId,inputTypes){
  if(Array.isArray(inputTypes))return inputTypes.some(value=>typeof value==='string'&&['image','image_url'].includes(value.toLowerCase()));
  return DOCUMENTED_IMAGE_MODELS.has(modelId);
}
const invalid=()=>{throw new ApiError(400,'INVALID_AI_IMAGE','图片无效或超过大小限制');};
export function validateAiImage(value){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['mimeType','data'].includes(key))||
    !['image/jpeg','image/png'].includes(value.mimeType)||typeof value.data!=='string'||value.data.length>Math.ceil(AI_IMAGE_LIMIT/3)*4||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value.data))invalid();
  const bytes=Buffer.from(value.data,'base64');
  if(!bytes.length||bytes.length>AI_IMAGE_LIMIT||bytes.toString('base64')!==value.data)invalid();
  let width,height;
  if(value.mimeType==='image/png'){
    if(bytes.length<33||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||bytes.toString('ascii',12,16)!=='IHDR')invalid();
    width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  }else{
    if(bytes.length<12||bytes.readUInt16BE(0)!==0xffd8||bytes.readUInt16BE(bytes.length-2)!==0xffd9)invalid();
    let offset=2;
    while(offset+4<=bytes.length){
      if(bytes[offset++]!==0xff)invalid();
      while(offset<bytes.length&&bytes[offset]===0xff)offset++;
      const marker=bytes[offset++];
      if(marker===0xda||marker===0xd9)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      if(offset+2>bytes.length)invalid();
      const length=bytes.readUInt16BE(offset);
      if(length<2||offset+length>bytes.length)invalid();
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(length<8)invalid();
        height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);break;
      }
      offset+=length;
    }
  }
  if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width>2048||height>2048||width*height>4_000_000)invalid();
  return {mimeType:value.mimeType,data:value.data};
}
export function aiImageDigest(image){return createHash('sha256').update(Buffer.from(image.data,'base64')).digest('hex');}
export function aiImageUrl(image){return `data:${image.mimeType};base64,${image.data}`;}
