import {ApiError} from './security.js';

// Reviewed 2026-11-06. CNY is used because Coze credit denominations have changed.
// Exact model IDs only. Source metadata is persisted with the job; it is not a model capability claim.
const VERSION='assistant-media-cny-2026-11-06';
const SOURCE='https://docs.coze.cn/coze_pro_internal_integrations_fee';
const ESTIMATE_SOURCE='https://docs.coze.cn/guides_video_generation_node';
const NANO_POINT=1_000_000_000n,CENTIPOINT=10_000_000n;
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw new ApiError(422,code,message);};
const invalid=message=>fail('MEDIA_REQUEST_INVALID',message);
const unknownUsage=()=>fail('MEDIA_USAGE_UNCONFIRMED','平台没有返回一致、完整的真实媒体用量，待核账；未按请求数量、时长或下载结果猜算扣点');
const imageDescription='图片参考倍率以Seedream 5.0 Lite单张费用为1×；按实际成功生成张数结算。';
const videoDescription='视频参考倍率以Seedance 1.5 Pro有声每千输出token费用为1×；按平台实际用量回执结算。';
const price=(modelId,kind,source,rates,displayMultiplier,displayUnitPrice,description,extra={})=>Object.freeze({
  version:VERSION,modelId,kind,currency:'CNY',pointsPerYuan:20,multiplier:'1.4',source,sourceUrl:SOURCE,
  unit:kind==='image'?'image':'1000_output_tokens',rates:Object.freeze(rates),displayMultiplier,displayUnitPrice,description,...extra});
const PRICES=Object.freeze({
  'doubao-seedream-5-0-260128':price('doubao-seedream-5-0-260128','image','coze_public',{image:'0.22'},'1×','6.16点/张',imageDescription),
  'doubao-seedream-4-5-251128':price('doubao-seedream-4-5-251128','image','coze_public',{image:'0.25'},'1.14×','7点/张',imageDescription),
  'doubao-seedance-1-5-pro-251215':price('doubao-seedance-1-5-pro-251215','video','coze_public',{audio:'0.016',silent:'0.008'},
    '1×','有声0.448点/千输出token；无声0.224点/千输出token',videoDescription+'当前有声1×、无声0.5×。'),
  // Application tariff derived from the verified 1.5 Pro tariff, not a verified Coze 2.0 quotation.
  'doubao-seedance-2-0-260128':price('doubao-seedance-2-0-260128','video','app_policy',{audio:'0.048',silent:'0.024'},
    '3×','有声1.344点/千输出token；无声0.672点/千输出token',videoDescription+'当前有声3×、无声1.5×。',{derivedMultiplier:3}),
});

export function mediaPricing(modelId,kind){
  const value=typeof modelId==='string'&&Object.hasOwn(PRICES,modelId)?PRICES[modelId]:null;
  if(!value||value.kind!==kind)fail('MEDIA_PRICE_UNAVAILABLE','该精确媒体型号未登记可用费率，未改用其他型号或猜测费用');
  return value;
}

function trustedPrice(value){
  if(!record(value))fail('MEDIA_PRICE_UNAVAILABLE','缺少已登记媒体费率快照');
  const trusted=mediaPricing(value.modelId,value.kind);
  if(Object.keys(trusted).some(key=>key==='rates'?!record(value.rates)||Object.keys(value.rates).length!==Object.keys(trusted.rates).length||
    Object.keys(trusted.rates).some(rate=>value.rates[rate]!==trusted.rates[rate]):value[key]!==trusted[key]))
    fail('MEDIA_PRICE_UNAVAILABLE','媒体费率快照不匹配，未用变更后的价格代替原费率');
  return trusted;
}

/** Resolve defaults once, before submission. Explicit parameters are validated, never rewritten. */
export function mediaEffectiveParameters(snapshot,params,references=[]){
  const p=trustedPrice(snapshot);
  if(!record(params)||!Array.isArray(references))invalid('媒体参数或参考图片列表格式无效');
  const allowed=p.kind==='image'?['prompt','size','count','watermark']:['prompt','reference_mode','resolution','ratio','duration','generate_audio','watermark'];
  if(Object.keys(params).some(key=>!allowed.includes(key)))invalid('媒体参数含尚未实现的字段');
  if(params.prompt!==undefined&&(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>12000))invalid('媒体提示词格式无效');
  if(params.watermark!==undefined&&typeof params.watermark!=='boolean')invalid('水印参数须为开或关');
  const effective={...params};
  if(p.kind==='image'){
    effective.size=params.size===undefined?'2K':params.size;
    effective.count=params.count===undefined?1:params.count;
    if(!Number.isSafeInteger(effective.count)||effective.count<1||effective.count>15)invalid('图片生成数量需为1–15');
    if(references.length>14)invalid('当前生图型号最多支持14张参考图');
    const lite=p.modelId==='doubao-seedream-5-0-260128',presets=lite?['2K','3K']:['2K','4K'];
    if(!presets.includes(effective.size)){
      const match=typeof effective.size==='string'?/^(\d{1,5})x(\d{1,5})$/u.exec(effective.size):null;
      const width=match?Number(match[1]):0,height=match?Number(match[2]):0,pixels=width*height;
      if(!match||width<1||height<1||width/height<1/16||width/height>16||pixels<3686400||pixels>(lite?3072*3072*1.1025:4096*4096))
        invalid('图片尺寸不符合所选实际型号的支持范围，未回退其他尺寸');
    }
  }else{
    effective.resolution=params.resolution===undefined?'720p':params.resolution;
    effective.ratio=params.ratio===undefined?'16:9':params.ratio;
    effective.duration=params.duration===undefined?5:params.duration;
    effective.generate_audio=params.generate_audio===undefined?true:params.generate_audio;
    if(!['480p','720p','1080p'].includes(effective.resolution))invalid('当前视频生成仅支持480p、720p和1080p');
    if(!['16:9','4:3','1:1','3:4','9:16','21:9','adaptive'].includes(effective.ratio))invalid('视频比例不在当前已登记范围');
    const v15=p.modelId==='doubao-seedance-1-5-pro-251215',max=v15?12:15;
    if(!Number.isSafeInteger(effective.duration)||effective.duration<4||effective.duration>max)invalid(`当前视频型号单段时长需为4–${max}秒；未修改所填时长`);
    if(typeof effective.generate_audio!=='boolean')invalid('视频声音参数须为开或关');
    if(references.length>(v15?2:9))invalid('参考图数量超出当前实际视频型号范围');
    effective.reference_mode=params.reference_mode===undefined?(references.length===1?'first_frame':'reference_images'):params.reference_mode;
    if(!['first_frame','first_last_frame','reference_images'].includes(effective.reference_mode))invalid('视频参考图片模式无效');
    if(references.length&&effective.reference_mode==='first_frame'&&references.length!==1)invalid('首帧模式需恰好一张参考图');
    if(effective.reference_mode==='first_last_frame'&&references.length!==2)invalid('首尾帧模式需按顺序提供两张参考图');
    if(v15&&references.length&&effective.reference_mode==='reference_images')invalid('Seedance 1.5 Pro仅支持首帧或首尾帧模式');
  }
  return effective;
}

// Official Coze reference pixel sizes. Portrait ratios transpose the equivalent landscape frame.
// These support a cost estimate only; neither the table nor this calculation promises a billing upper bound.
const PIXELS=Object.freeze({
  '480p':{'16:9':[864,496],'4:3':[752,560],'1:1':[640,640],'21:9':[992,432]},
  '720p':{'16:9':[1280,720],'4:3':[1112,834],'1:1':[960,960],'21:9':[1470,630]},
  '1080p':{'16:9':[1920,1080],'4:3':[1664,1248],'1:1':[1440,1440],'21:9':[2205,945]},
});
function videoDimensions(params){
  const choices=PIXELS[params.resolution];
  if(!choices)fail('MEDIA_BUDGET_UNCONFIRMED','缺少该视频分辨率的可核实预估依据，未改动请求参数');
  if(params.ratio==='adaptive')return Object.values(choices).reduce((max,item)=>item[0]*item[1]>max[0]*max[1]?item:max,[0,0]);
  if(params.ratio==='3:4')return [...choices['4:3']].reverse();
  if(params.ratio==='9:16')return [...choices['16:9']].reverse();
  if(!choices[params.ratio])fail('MEDIA_BUDGET_UNCONFIRMED','缺少该视频比例的可核实预估依据，未改动请求参数');
  return choices[params.ratio];
}

function nanoRate(cny,unit){
  const match=typeof cny==='string'?/^(\d+)(?:\.(\d{1,8}))?$/u.exec(cny):null;
  if(!match)throw new Error('MEDIA_PRICE_RECORD_INVALID');
  const fraction=match[2]??'',scale=10n**BigInt(fraction.length),numerator=(BigInt(match[1])*scale+BigInt(fraction||'0'))*28n*NANO_POINT;
  const divisor=scale*BigInt(unit);
  if(numerator%divisor!==0n)throw new Error('MEDIA_PRICE_PRECISION_INVALID');
  return numerator/divisor;
}

/** Financial authorization estimate; never an actual usage receipt or a successful deduction. */
export function mediaQuote(snapshot,effectiveParams){
  const p=trustedPrice(snapshot);
  if(!record(effectiveParams))invalid('缺少已解析的媒体参数');
  let amount,basis,estimated,description;
  if(p.kind==='image'){
    if(!Number.isSafeInteger(effectiveParams.count)||effectiveParams.count<1||effectiveParams.count>15)invalid('缺少有效的图片生成最大张数');
    amount=BigInt(effectiveParams.count)*nanoRate(p.rates.image,1);
    basis={generatedImages:effectiveParams.count};estimated=false;
    description='按本次请求的最大生成张数预留；最终只按实际成功生成张数结算。';
  }else{
    if(!Number.isSafeInteger(effectiveParams.duration)||effectiveParams.duration<4||effectiveParams.duration>(p.modelId==='doubao-seedance-1-5-pro-251215'?12:15)||typeof effectiveParams.generate_audio!=='boolean')
      invalid('缺少有效的视频时长或声音档位');
    const [width,height]=videoDimensions(effectiveParams),frames=24*effectiveParams.duration;
    const completionTokens=Math.ceil(width*height*frames/1024);
    amount=BigInt(completionTokens)*nanoRate(effectiveParams.generate_audio?p.rates.audio:p.rates.silent,1000);
    basis={completionTokens,width,height,fps:24,duration:effectiveParams.duration,adaptive:effectiveParams.ratio==='adaptive',sourceUrl:ESTIMATE_SOURCE,
      referenceModelId:'doubao-seedance-1-5-pro-251215'};
    estimated=true;
    description=effectiveParams.ratio==='adaptive'?'按官方参考像素中同分辨率较高值估算；这是预留估算，不保证实际费用上界，最终按真实回执结算。':
      '按参考像素、24帧/秒与时长估算；不保证实际费用上界，最终按真实回执结算。';
  }
  const units=(amount+CENTIPOINT-1n)/CENTIPOINT;
  if(units>BigInt(Number.MAX_SAFE_INTEGER))fail('MEDIA_BUDGET_UNCONFIRMED','预留金额超过当前账本安全范围');
  return {amountNanos:String(amount),units:Number(units),estimated,guaranteedUpperBound:!estimated,basis,description};
}

/** Normalize provider counters and persisted normalized counters without copying arbitrary provider data. */
export function mediaUsage(raw,kind){
  if(!record(raw)||!['image','video'].includes(kind)||raw.usage!==undefined&&!record(raw.usage))unknownUsage();
  const containers=raw.usage===undefined?[raw]:[raw,raw.usage];
  const counter=(names,required)=>{
    const values=containers.flatMap(container=>names.filter(name=>Object.hasOwn(container,name)).map(name=>container[name]));
    if(values.some(value=>!Number.isSafeInteger(value)||value<0)||values.some(value=>value!==values[0])||required&&!values.length)unknownUsage();
    return values.length?values[0]:undefined;
  };
  if(kind==='image'){
    const generatedImages=counter(['generated_images','generatedImages'],true);
    return {generatedImages};
  }
  const output=counter(['completion_tokens','completionTokens'],false),total=counter(['total_tokens'],false);
  if(output===undefined&&total===undefined||output!==undefined&&total!==undefined&&output!==total)unknownUsage();
  // Video API does not count input tokens: total_tokens is an alternative, never an additional charge.
  return {completionTokens:output===undefined?total:output};
}

export function mediaCost(snapshot,usage,effectiveParams){
  const p=trustedPrice(snapshot),actual=mediaUsage(usage,p.kind);
  if(p.kind==='image')return {nanos:BigInt(actual.generatedImages)*nanoRate(p.rates.image,1),rates:{...p.rates,selected:'image'}};
  if(!record(effectiveParams)||typeof effectiveParams.generate_audio!=='boolean')fail('MEDIA_USAGE_UNCONFIRMED','缺少本次视频的实际声音计费档位，待核账');
  const selected=effectiveParams.generate_audio?'audio':'silent';
  return {nanos:BigInt(actual.completionTokens)*nanoRate(p.rates[selected],1000),rates:{...p.rates,selected}};
}
