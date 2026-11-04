const text=(maxLength=200)=>({type:'string',maxLength});
const refs={type:'array',maxItems:14,items:text(80)};
const tool=(name,description,properties,required=[])=>({type:'function',function:{name,description,
  parameters:{type:'object',properties,required,additionalProperties:false}}});

const definitions=[
  tool('generate_image','仅在用户明确要求生成或编辑图片时调用Coze生图。返回真实生成任务编号；随后用get_media_generation取回文件。参考图只能是当前会话明确提供的文件ID，不能用缩略图或猜路径。可选参数仅按用户明确要求填写，不填则使用接口默认。',
    {prompt:text(12000),reference_file_ids:refs,size:text(32),count:{type:'integer',minimum:1,maximum:15},watermark:{type:'boolean'}},['prompt']),
  tool('generate_video','仅在用户明确要求生成视频时调用Coze视频模型。提交后得到任务编号，不代表已生成。通过get_media_generation等待并取回真实视频。参考图使用当前会话文件ID，单图为首帧，多图仅在所选模型支持时作为参考图。可选参数只按用户明确要求填写，缺省沿用接口默认。',
    {prompt:text(12000),reference_file_ids:refs,reference_mode:{type:'string',enum:['first_frame','first_last_frame','reference_images']},
      resolution:text(16),ratio:text(16),duration:{type:'integer',minimum:1,description:'按所选型号已登记或平台实际支持的单段时长填写，不能将整数范围当作模型能力'},generate_audio:{type:'boolean'},watermark:{type:'boolean'}},['prompt']),
  tool('get_media_generation','查询或等待当前会话已有生成任务，并下载校验已完成图片/视频到App私有目录。默认等待完成，不必反复调用模型查询。排队、生成中、未知、失败都不能声称生成成功；不要为等待中的任务重复提交生成。',
    {job_id:text(80),wait:{type:'boolean'}},['job_id']),
  tool('cancel_media_generation','请求停止当前会话生成任务。以回执判断是否真正取消；已交平台的任务可能无法安全取消，此时保留记录供历史取回，不能宣称已取消或删除已完成结果。',
    {job_id:text(80)},['job_id']),
];

export const ASSISTANT_MEDIA_TOOL_NAMES=Object.freeze(definitions.map(item=>item.function.name));
export function assistantMediaTools(){return structuredClone(definitions);}
