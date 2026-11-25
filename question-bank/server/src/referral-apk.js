import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {ApiError} from './security.js';

// Locate the APK Signing Block using the layout in Walle ApkUtil (Apache-2.0).
// Fit the metadata into verity padding so the APK length and alignment are preserved.
const MAGIC=Buffer.from('APK Sig Block 42');
const VERITY_PADDING=0x42726577, CHANNEL=0x71777777;
const MAX_APK=96*1024*1024, MAX_BLOCK=1024*1024;
const unavailable=()=>new ApiError(503,'REFERRAL_PACKAGE_UNAVAILABLE','分享安装包暂未就绪');
const hash=parts=>{const digest=createHash('sha256');for(const part of parts)digest.update(part);return digest.digest('hex');};

export function referralSlot(apk){
  if(apk.length<22)throw unavailable();
  const lower=Math.max(0,apk.length-65557);
  let eocd=apk.length-22;
  for(;eocd>=lower;eocd--)if(apk.readUInt32LE(eocd)===0x06054b50&&eocd+22+apk.readUInt16LE(eocd+20)===apk.length)break;
  if(eocd<lower||apk.readUInt32LE(eocd+4)!==0)throw unavailable();
  const central=apk.readUInt32LE(eocd+16);
  if(central<32||central+apk.readUInt32LE(eocd+12)!==eocd||!apk.subarray(central-16,central).equals(MAGIC))throw unavailable();
  const size=Number(apk.readBigUInt64LE(central-24)),start=central-size-8,end=central-24;
  if(size<24||size>MAX_BLOCK||start<0||apk.readBigUInt64LE(start)!==BigInt(size))throw unavailable();
  let padding=null,signed=false;
  for(let position=start+8;position<end;){
    if(end-position<12)throw unavailable();
    const length=Number(apk.readBigUInt64LE(position)),key=apk.readUInt32LE(position+8);
    if(length<4||length>end-position-8||key===CHANNEL)throw unavailable();
    if(key===0x7109871a)signed=true;
    if(key===VERITY_PADDING){
      if(padding||length<4+43+12||apk.subarray(position+12,position+8+length).some(byte=>byte!==0))throw unavailable();
      padding={offset:position,end:position+8+length};
    }
    position+=8+length;
  }
  if(!signed||!padding)throw unavailable();
  return padding;
}

export function referralVariant(base,slot,code){
  if(!/^[A-Za-z0-9_-]{43}$/u.test(code))throw unavailable();
  const patch=Buffer.alloc(slot.end-slot.offset);
  const write=(offset,key,length)=>{patch.writeBigUInt64LE(BigInt(length+4),offset);patch.writeUInt32LE(key,offset+8);};
  write(0,CHANNEL,43);patch.write(code,12,'ascii');
  write(55,VERITY_PADDING,patch.length-67);
  const parts=[base.subarray(0,slot.offset),patch,base.subarray(slot.end)];
  return {length:base.length,sha256:hash(parts),stream:Readable.from(parts)};
}

export function configuredReferralDistribution(url,fetchImpl=fetch){
  if(!url)return null;
  const official=/^https:\/\/github\.com\/aokil\/newfloat-ai\/releases\/download\/android-v([1-9]\d*)\/tiyu-([a-f0-9]{64})\.apk$/u.exec(url);
  if(!official||Number(official[1])<81)return null;
  let baseLoad=null;
  async function load(){
    try {
      const response=await fetchImpl(url,{signal:AbortSignal.timeout(30_000),headers:{'Accept-Encoding':'identity'}});
      const declared=Number(response.headers.get('content-length')||0);
      if(!response.ok||!response.body||!Number.isSafeInteger(declared)||declared<0||declared>MAX_APK)throw unavailable();
      const chunks=[];let bytes=0;
      for await(const chunk of response.body){bytes+=chunk.length;if(bytes>MAX_APK)throw unavailable();chunks.push(Buffer.from(chunk));}
      if((declared&&declared!==bytes)||hash(chunks)!==official[2])throw unavailable();
      const base=Buffer.concat(chunks,bytes);
      return {base,slot:referralSlot(base)};
    }catch{throw unavailable();}
  }
  const prepare=()=>baseLoad??=(load().catch(error=>{baseLoad=null;throw error;}));
  return {prepare,async package(code){const {base,slot}=await prepare();return referralVariant(base,slot,code);}};
}
