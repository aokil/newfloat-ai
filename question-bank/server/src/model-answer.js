const invalid=()=>{throw new Error('INVALID_ANSWER');};
const empty=()=>{throw new Error('EMPTY_RESPONSE');};
const prefix=/^(?:正确)?答案(?:\s*[:：]\s*|\s*(?:是|为)\s*[:：]?\s*)/u;
const noAnswer=/^(?:抱歉[，,\s]*)?(?:信息不足|无法识别(?:图片|图像|题目)|未能识别(?:图片|图像|题目)|图片不清晰|题目不完整|没有完整题目)/u;
function answerText(value){
  if(typeof value==='string'){
    const text=value.trim().replace(prefix,'').trim();
    if(!text)empty();
    if(noAnswer.test(text))empty();
    if(text.length>16000)invalid();
    return text;
  }
  if(typeof value==='boolean')return value?'对':'错';
  if(value===null||(Array.isArray(value)&&value.length===0))empty();
  if(typeof value==='number'){
    if(!Number.isFinite(value)||(Number.isInteger(value)&&!Number.isSafeInteger(value)))invalid();
    return String(value);
  }
  if(Array.isArray(value)&&value.length>0&&value.length<=16&&value.every(item=>['string','number','boolean'].includes(typeof item))){
    const text=value.map(answerText).join('、');
    if(text.length>16000)invalid();
    return text;
  }
  invalid();
}
/** Model replies are data: accept an answer field or a complete plain answer, never execute extra fields. */
export function parseModelAnswer(content){
  if(typeof content!=='string'||content.length>96000)invalid();
  const text=content.trim().replace(/^\x60{3}(?:json|text)?\s*\n?([\s\S]*?)\n?\x60{3}$/iu,'$1').trim().replace(prefix,'').trim();
  if(!text)empty();
  let value;
  try{value=JSON.parse(text);}catch{
    // A cut-off structured response is not a complete plain-text answer.
    if(['{','[','"','```'].some(marker=>text.startsWith(marker)))invalid();
    return {answer:answerText(text),explanation:''};
  }
  const answer=value&&typeof value==='object'&&!Array.isArray(value)
    ? (Object.hasOwn(value,'answer')?value.answer:invalid()) : value;
  // Preserve a bare JSON number's original digits instead of rounding through Number.
  return {answer:typeof value==='number'?answerText(text):answerText(answer),explanation:''};
}
/** Usage-only stream chunks carry no answer text. Unknown output blocks remain invalid. */
export function modelText(content){
  if(content===undefined||content===null)return '';
  if(typeof content==='string')return content;
  if(!Array.isArray(content))invalid();
  let text='';
  for(const block of content){
    if(block&&typeof block==='object'&&['text','output_text'].includes(block.type)&&typeof block.text==='string')text+=block.text;
    else if(!block||typeof block!=='object'||!['reasoning','thinking','reasoning_content','redacted_thinking'].includes(block.type))invalid();
  }
  return text;
}
