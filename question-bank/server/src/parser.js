import {Worker} from 'node:worker_threads';
import {ApiError} from './security.js';
let running=0;
export async function parseFile(filename,bytes) {
  if(!/\.(csv|tsv|json|jsonl|txt|xlsx|docx|pdf)$/iu.test(filename))throw new ApiError(415,'UNSUPPORTED_FORMAT','文件格式尚未支持');
  if(running>=2)throw new ApiError(503,'UNAVAILABLE','解析队列繁忙，请重试');
  running++;
  try { return await new Promise((resolve,reject)=> {
    const worker=new Worker(new URL('./parser-worker.js',import.meta.url),{workerData:{filename,bytes},resourceLimits:{maxOldGenerationSizeMb:256}});
    let finished=false;
    const finish=async(error,result)=>{if(finished)return;finished=true;clearTimeout(timeout);await worker.terminate().catch(()=>{});if(error)reject(error);else resolve(result);};
    const timeout=setTimeout(()=>{void finish(new ApiError(422,'VALIDATION_FAILED','解析超过20秒处理预算'));},20000);
    worker.once('message',message=> {void finish(message.error?new ApiError(422,'VALIDATION_FAILED',message.error):null,message.result);});
    worker.once('error',error=>{void finish(new ApiError(422,'VALIDATION_FAILED',`文件解析失败：${error.message}`));});
    worker.once('exit',()=>{if(!finished)void finish(new ApiError(422,'VALIDATION_FAILED','文件解析资源预算耗尽或已中止'));});
  }); } finally { running--; }
}
