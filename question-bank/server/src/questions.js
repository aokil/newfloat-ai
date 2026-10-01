import {ApiError} from './security.js';
export const TYPES = ['single_choice','multiple_choice','true_false','fill_blank','short_answer','unknown'];
export const EDIT_FIELDS = ['questionId','questionType','stem','options','answerText','answerOptionIds','answerBoolean','answerParts','expectedBlankCount','answerComplete','explanation','sourceName'];
export function booleanLabel(text) {
  if (['正确','对','是','√','true','True','TRUE'].includes(text.trim())) return true;
  if (['错误','错','否','×','false','False','FALSE'].includes(text.trim())) return false;
  return null;
}
export const partsText = parts => parts.length === 1 ? parts[0].text : parts.map(p => `${p.position}. ${p.text}`).join('\n');
export function inspectQuestion(input, questionId, strictFields = false) {
  const errors = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {stem: '', answerText: ''};
  if (strictFields && Object.keys(input).some(k => !EDIT_FIELDS.includes(k))) throw new ApiError(400, 'INVALID_REQUEST', '题目含不可编辑的身份/版本或未知字段');
  const q = {questionId, questionType: input.questionType ?? 'unknown', stem: input.stem ?? '', options: input.options ?? [],
    answerText: input.answerText ?? '', answerOptionIds: input.answerOptionIds ?? [], answerComplete: input.answerComplete ?? false,
    explanation: input.explanation ?? '', sourceName: input.sourceName ?? ''};
  for (const key of ['answerBoolean','answerParts','expectedBlankCount']) if (input[key] !== undefined) q[key] = input[key];
  for (const [key,max] of [['stem',8192],['answerText',32768],['explanation',32768],['sourceName',1024]])
    if (typeof q[key] !== 'string' || q[key].length > max) errors.push(`${key}须为不超过${max}字符的文本`);
  if (typeof q.stem === 'string' && !q.stem.trim()) errors.push('题干为空');
  if (!TYPES.includes(q.questionType)) errors.push('题型无效');
  if (typeof q.answerComplete !== 'boolean') errors.push('answerComplete须为布尔值');
  if (!Array.isArray(q.options) || q.options.length > 32 || q.options.some(o => !o || typeof o.id !== 'string' || !o.id.trim() || o.id.length > 128 || typeof o.text !== 'string' || !o.text.trim() || o.text.length > 2048)) errors.push('选项结构无效');
  if (!Array.isArray(q.answerOptionIds) || q.answerOptionIds.some(id => typeof id !== 'string')) errors.push('答案选项ID须为数组');
  if (q.answerParts!==undefined&&!Array.isArray(q.answerParts))errors.push('answerParts须为数组');
  if (errors.length) return {question: q, errors, complete: false};
  if (new Set(q.options.map(o => o.id)).size !== q.options.length || new Set(q.answerOptionIds).size !== q.answerOptionIds.length || q.answerOptionIds.some(id => !q.options.some(o => o.id === id))) errors.push('选项ID重复或答案指向不存在的选项');
  if (q.questionType !== 'true_false' && q.answerBoolean !== undefined) errors.push('非判断题不得提供布尔答案');
  if (q.questionType !== 'fill_blank' && ((q.answerParts?.length ?? 0) > 0 || q.expectedBlankCount !== undefined)) errors.push('非填空题不得提供填空结构');
  let evidence = false;
  switch (q.questionType) {
    case 'single_choice': case 'multiple_choice': {
      if (!q.options.length || (q.questionType === 'single_choice' && q.answerOptionIds.length > 1)) errors.push('选择题选项或答案数无效');
      const answer = q.answerOptionIds.map(id => q.options.find(o => o.id === id)?.text ?? '').join('\n');
      if (q.answerOptionIds.length && q.answerText && answer !== q.answerText) errors.push('答案正文与选项ID冲突');
      evidence = q.answerOptionIds.length > 0 && answer === q.answerText; break;
    }
    case 'true_false':
      if (q.answerOptionIds.length || (q.options.length && (q.options.length !== 2 || new Set(q.options.map(o => booleanLabel(o.text))).size !== 2 || q.options.some(o => booleanLabel(o.text) === null)))) errors.push('判断题选项无效');
      if (q.answerBoolean !== undefined && typeof q.answerBoolean !== 'boolean') errors.push('布尔答案无效');
      if (q.answerBoolean !== undefined && q.answerText && booleanLabel(q.answerText) !== q.answerBoolean) errors.push('布尔答案与正文冲突');
      evidence = typeof q.answerBoolean === 'boolean' && booleanLabel(q.answerText) === q.answerBoolean; break;
    case 'fill_blank': {
      const parts = q.answerParts ?? [];
      if (q.options.length || q.answerOptionIds.length || !Array.isArray(parts) || parts.some((p,i) => !p || p.position !== i+1 || typeof p.text !== 'string' || !p.text.trim() || p.text.length>8192)) errors.push('填空答案须按连续空位顺序给出，每空不超过8192字符');
      if (q.expectedBlankCount !== undefined && (!Number.isSafeInteger(q.expectedBlankCount) || q.expectedBlankCount <= 0 || q.expectedBlankCount>2147483647 || parts.length > q.expectedBlankCount)) errors.push('来源空位数无效');
      if (Array.isArray(parts) && parts.length && q.answerText && q.answerText !== partsText(parts)) errors.push('填空正文与结构答案冲突');
      evidence = Array.isArray(parts) && parts.length > 0 && parts.length === q.expectedBlankCount && q.answerText === partsText(parts); break;
    }
    case 'short_answer':
      if (q.options.length || q.answerOptionIds.length) errors.push('简答题不能含选择题选项');
      evidence = !!q.answerText.trim() && !['见解析','详见解析','见图','见附图','见附件','略','答案略','详见答案','参见解析',''].includes(q.answerText.trim().replace(/[.。!！…]+$/u,'')); break;
    case 'unknown': evidence = false; break;
  }
  if (q.answerComplete && (!evidence || errors.length)) errors.push('声明完整但答案缺少有效结构证据');
  return {question: q, errors: [...new Set(errors)], complete: q.answerComplete === true && evidence && !errors.length};
}
