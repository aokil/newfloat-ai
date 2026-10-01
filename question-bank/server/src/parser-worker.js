import {parentPort, workerData} from 'node:worker_threads';
import {parse} from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import yauzl from 'yauzl';
import {inspectQuestion, booleanLabel, partsText} from './questions.js';

const MAX_TEXT = 2 * 1024 * 1024;
function text(bytes) { return new TextDecoder('utf-8', {fatal:true}).decode(bytes).replace(/^\uFEFF/u,''); }
function zipBudget(bytes) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {lazyEntries:true}, (error, zip) => {
    if (error) return reject(error);
    let count=0, total=0, actual=0;
    zip.on('error', reject); zip.on('end', resolve);
    zip.on('entry', e => {
      count++; total += e.uncompressedSize;
      if (count > 2000 || total > 64 * 1024 * 1024 || e.generalPurposeBitFlag & 1 || /(^\/|^[A-Za-z]:|(^|\/)\.\.(\/|$)|\\)/u.test(e.fileName)) {
        zip.close(); reject(new Error('压缩包路径、加密或解压预算不符合要求')); return;
      }
      if(e.fileName.endsWith('/')){zip.readEntry();return;}
      zip.openReadStream(e,(streamError,stream)=>{
        if(streamError){zip.close();reject(streamError);return;}
        stream.on('data',chunk=>{actual+=chunk.length;if(actual>64*1024*1024){stream.destroy(new Error('实际解压字节超过64MiB预算'));zip.close();}});
        stream.on('error',error=>{zip.close();reject(error);});stream.on('end',()=>zip.readEntry());
      });
    });
    zip.readEntry();
  }));
}
function zipEntry(bytes, target) {
  return new Promise((resolve, reject) => yauzl.fromBuffer(bytes, {lazyEntries:true}, (error, zip) => {
    if (error) return reject(error);
    let settled=false;
    const fail=reason=>{if(settled)return;settled=true;try{zip.close();}catch{}reject(reason);};
    zip.on('error',fail);
    zip.on('end',()=>{if(!settled){settled=true;reject(new Error(`DOCX缺少${target}`));}});
    zip.on('entry',entry=>{
      if(entry.fileName!==target){zip.readEntry();return;}
      zip.openReadStream(entry,(streamError,stream)=>{
        if(streamError){fail(streamError);return;}
        const chunks=[];let total=0;
        stream.on('data',chunk=>{total+=chunk.length;if(total>MAX_TEXT*4)stream.destroy(new Error('DOCX正文XML超过解析预算'));else chunks.push(chunk);});
        stream.on('error',fail);stream.on('end',()=>{if(settled)return;settled=true;zip.close();resolve(Buffer.concat(chunks).toString('utf8'));});
      });
    });
    zip.readEntry();
  }));
}
function xmlText(value) {
  return value.replace(/<w:(?:tab)\b[^>]*\/>/gu,'\t').replace(/<w:(?:br|cr)\b[^>]*\/>/gu,'\n')
    .replace(/<[^>]+>/gu,'').replace(/&lt;/gu,'<').replace(/&gt;/gu,'>').replace(/&quot;/gu,'"')
    .replace(/&apos;/gu,"'").replace(/&amp;/gu,'&').replace(/&#(\d+);/gu,(_,n)=>String.fromCodePoint(Number(n)))
    .replace(/&#x([\da-f]+);/gui,(_,n)=>String.fromCodePoint(Number.parseInt(n,16)));
}
function docxParagraphs(xml) {
  return [...xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/gu)].map((match,index)=>({
    index:index+1,
    text:xmlText(match[1]).replace(/\u00a0/gu,' ').trim(),
    numbered:/<w:numPr\b/gu.test(match[1])
  }));
}
const CHAPTER_TYPES={单选题:'single_choice',多选题:'multiple_choice',判断题:'true_false'};
function chapterHeading(value) {
  const match=value.replace(/\s+/gu,'').match(/^[一二三四五六七八九十]+[、.]?(单选题|多选题|判断题)[（(]共?(\d+)题[）)]/u);
  return match?{questionType:CHAPTER_TYPES[match[1]],expected:Number(match[2])}:null;
}
function questionMarker(value, atStart=true) {
  const pattern=atStart?/^\s*(\d{1,5})[.．、]\s*/u:/(?:^|[）)\]】。；;])\s*(\d{1,5})[.．、]\s*/gu;
  if(atStart){const match=value.match(pattern);return match?{number:Number(match[1]),offset:match.index,length:match[0].length}:null;}
  return [...value.matchAll(pattern)].map(match=>({number:Number(match[1]),offset:match.index+match[0].lastIndexOf(match[1]),length:match[1].length+1}));
}
function splitOptions(value) {
  const normalized=value.replace(/\r/gu,'');
  const markers=[...normalized.matchAll(/([A-H])[.．、)）]\s*/gu)];
  let start=markers.findIndex(marker=>marker.index===0||normalized[marker.index-1]==='\n');
  if(start<0)start=markers.findIndex(marker=>marker[1]==='A');
  if(start<0)return {stem:normalized.trim(),options:[]};
  const selected=[];let expected=markers[start][1].codePointAt(0);
  for(let i=start;i<markers.length;i++){
    const marker=markers[i];
    if(marker[1].codePointAt(0)!==expected)continue;
    selected.push(marker);expected++;
  }
  if(selected.length<2)return {stem:normalized.trim(),options:[]};
  const options=selected.map((marker,index)=>({id:marker[1],text:normalized.slice(marker.index+marker[0].length,selected[index+1]?.index??normalized.length).trim()}));
  if(options.some(option=>!option.text))return {stem:normalized.trim(),options:[]};
  return {stem:normalized.slice(0,selected[0].index).trim(),options};
}
function extractChoiceAnswer(value, options) {
  const ids=new Set(options.map(option=>option.id));
  const candidates=[...value.matchAll(/答案\s*[:：]\s*([A-H](?:[\s,，、;；]*[A-H])*)/gu),
    ...value.matchAll(/[（(\[【]\s*([A-H](?:[\s,，、;；]*[A-H])*)\s*[）)\]】]/gu)];
  for(const match of candidates){
    const answer=[...match[1].matchAll(/[A-H]/gu)].map(part=>part[0]);
    if(answer.length&&answer.every(id=>ids.has(id)))return {answer,clean:value.slice(0,match.index)+value.slice(match.index+match[0].length)};
  }
  return {answer:[],clean:value};
}
function extractBooleanAnswer(value) {
  const candidates=[...value.matchAll(/答案\s*[:：]\s*(正确|错误|对|错|是|否|√|×|true|false)/gui),
    ...value.matchAll(/[（(\[【]\s*(正确|错误|对|错|是|否|√|×|true|false)\s*[）)\]】]/gui)];
  for(const match of candidates){const answer=booleanLabel(match[1]);if(answer!==null)return {answer,clean:value.slice(0,match.index)+value.slice(match.index+match[0].length)};}
  return {clean:value};
}
function countedDocx(paragraphs, source) {
  const headings=paragraphs.map((paragraph,index)=>({...chapterHeading(paragraph.text),index})).filter(item=>item.questionType);
  if(!headings.length)return null;
  const rows=[];
  for(let chapterIndex=0;chapterIndex<headings.length;chapterIndex++){
    const heading=headings[chapterIndex], end=headings[chapterIndex+1]?.index??paragraphs.length;
    const section=paragraphs.slice(heading.index+1,end);
    const starts=[];
    for(let i=0;i<section.length;i++){
      const marker=questionMarker(section[i].text);
      if(marker)starts.push({number:marker.number,paragraph:i,offset:marker.length,explicit:true});
      for(const embedded of questionMarker(section[i].text,false)){
        if(embedded.offset>0&&!starts.some(start=>start.paragraph===i&&start.number===embedded.number))starts.push({number:embedded.number,paragraph:i,offset:embedded.offset+embedded.length,markerOffset:embedded.offset,explicit:true});
      }
    }
    starts.sort((a,b)=>a.paragraph-b.paragraph||(a.markerOffset??0)-(b.markerOffset??0));
    const explicitNumbers=new Set(starts.map(start=>start.number));
    for(let number=1;number<=heading.expected;number++){
      if(explicitNumbers.has(number))continue;
      const previous=[...starts].filter(start=>start.number<number).sort((a,b)=>b.number-a.number)[0];
      const next=[...starts].filter(start=>start.number>number).sort((a,b)=>a.number-b.number)[0];
      const candidates=[];
      for(let paragraph=previous?.paragraph??0;paragraph<=(next?.paragraph??section.length-1);paragraph++){
        for(const marker of section[paragraph].text.matchAll(/(\d{1,5})[.．、](?!\d)\s*/gu)){
          if(Number(marker[1])===number&&!(marker.index===0&&starts.some(start=>start.paragraph===paragraph)))
            candidates.push({number,paragraph,offset:marker.index+marker[0].length,markerOffset:marker.index,explicit:true});
        }
      }
      if(candidates.length===1){starts.push(candidates[0]);explicitNumbers.add(number);}
    }
    for(let number=1;number<=heading.expected;number++){
      if(explicitNumbers.has(number))continue;
      const previous=[...starts].reverse().find(start=>start.number<number);
      const next=starts.find(start=>start.number>number);
      const candidates=section.map((paragraph,index)=>({paragraph,index})).filter(candidate=>candidate.paragraph.numbered
        && !/^[A-H][.．、)）]/u.test(candidate.paragraph.text)
        && candidate.index>(previous?.paragraph??-1)&&candidate.index<(next?.paragraph??section.length)
        && !starts.some(start=>start.paragraph===candidate.index));
      const missing=[];for(let n=(previous?.number??0)+1;n<(next?.number??heading.expected+1);n++)if(!explicitNumbers.has(n))missing.push(n);
      if(candidates.length!==missing.length)continue;
      for(let i=0;i<missing.length;i++){
        const inferred={number:missing[i],paragraph:candidates[i].index,offset:0,explicit:false};starts.push(inferred);explicitNumbers.add(missing[i]);
      }
    }
    starts.sort((a,b)=>a.paragraph-b.paragraph||(a.markerOffset??0)-(b.markerOffset??0));
    const actual=starts.map(start=>start.number), expected=Array.from({length:heading.expected},(_,i)=>i+1);
    if(actual.length!==expected.length||actual.some((number,index)=>number!==expected[index])){
      const missing=expected.filter(number=>!actual.includes(number));
      throw new Error(`${source} 的${heading.questionType}章节切分失败：期望${heading.expected}题，识别${actual.length}题，缺少题号${missing.slice(0,20).join('、')||'无'}；请保留原件并检查第${paragraphs[heading.index].index}段后的编号结构`);
    }
    for(let i=0;i<starts.length;i++){
      const start=starts[i], next=starts[i+1];let content='';
      const finalParagraph=next?.paragraph??section.length-1;
      for(let paragraphIndex=start.paragraph;paragraphIndex<=finalParagraph;paragraphIndex++){
        let value=section[paragraphIndex].text;
        if(paragraphIndex===start.paragraph)value=value.slice(start.offset);
        if(next&&paragraphIndex===next.paragraph)value=value.slice(0,next.markerOffset??0);
        if(value.trim())content+=(content?'\n':'')+value.trim();
      }
      const base={questionType:heading.questionType,sourceName:`${source} · ${heading.questionType}第${start.number}题 · 第${section[start.paragraph].index}段`};
      if(heading.questionType==='true_false'){
        let parsed=splitOptions(content),direct=extractBooleanAnswer(parsed.stem),mapped;
        if(direct.answer!==undefined)parsed={...parsed,stem:direct.clean};
        if(direct.answer===undefined){const whole=extractBooleanAnswer(content);if(whole.answer!==undefined){parsed=splitOptions(whole.clean);direct=whole;}}
        if(direct.answer===undefined&&parsed.options.length){
          let choice=extractChoiceAnswer(parsed.stem,parsed.options);
          if(choice.answer.length)parsed={...parsed,stem:choice.clean};
          else {choice=extractChoiceAnswer(content,parsed.options);if(choice.answer.length)parsed=splitOptions(choice.clean);}
          if(choice.answer.length===1)mapped=booleanLabel(parsed.options.find(option=>option.id===choice.answer[0])?.text??'');
          if(mapped!==null&&mapped!==undefined)direct={answer:mapped,clean:choice.clean};
        }
        rows.push({...base,stem:parsed.stem.trim(),options:parsed.options,
          answerText:direct.answer===undefined?'':direct.answer?'正确':'错误',...(direct.answer===undefined?{}:{answerBoolean:direct.answer}),answerComplete:direct.answer!==undefined});
      }else{
        let parsed=splitOptions(content);const answer=extractChoiceAnswer(parsed.stem,parsed.options);
        if(!answer.answer.length){const whole=extractChoiceAnswer(content,parsed.options);if(whole.answer.length)parsed=splitOptions(whole.clean);answer.answer=whole.answer;}
        const answerText=answer.answer.map(id=>parsed.options.find(option=>option.id===id)?.text??'').join('\n');
        const incompleteOptionSequence=parsed.options.length&&parsed.options[0].id!=='A';
        rows.push({...base,sourceName:incompleteOptionSequence?`${base.sourceName} · 原文选项从${parsed.options[0].id}开始，待核对`:base.sourceName,
          stem:(answer.clean===content?parsed.stem:answer.clean).trim(),options:parsed.options,answerOptionIds:answer.answer,answerText,
          answerComplete:answer.answer.length>0&&!incompleteOptionSequence});
      }
    }
  }
  return rows;
}
const aliases = {题干:'stem',题目:'stem',题型:'questionType',答案:'answer',解析:'explanation',来源:'sourceName',完整:'answerComplete',空位数:'expectedBlankCount'};
const typeNames = {'单选':'single_choice','多选':'multiple_choice','判断':'true_false','填空':'fill_blank','简答':'short_answer'};
function rowObject(row) {
  const o = Object.fromEntries(Object.entries(row).map(([k,v]) => [aliases[k.trim()] || k.trim(), v]));
  if (o.questionType) o.questionType = typeNames[o.questionType] || o.questionType;
  for (const key of ['options','answerOptionIds','answerParts']) if (typeof o[key] === 'string') {
    if(!o[key].trim())delete o[key];
    else try { o[key] = JSON.parse(o[key]); } catch { /* Keep invalid original for visible correction. */ }
  }
  if (o.expectedBlankCount !== undefined && String(o.expectedBlankCount).trim() !== '') o.expectedBlankCount = Number(o.expectedBlankCount); else delete o.expectedBlankCount;
  if (typeof o.answerComplete === 'string') o.answerComplete = o.answerComplete === 'true' ? true : o.answerComplete === 'false' || o.answerComplete === '' ? false : o.answerComplete;
  if (typeof o.answerBoolean === 'string') {if(!o.answerBoolean.trim())delete o.answerBoolean;else o.answerBoolean = o.answerBoolean === 'true' ? true : o.answerBoolean === 'false' ? false : o.answerBoolean;}
  if(typeof o.questionType==='string'&&!o.questionType.trim())delete o.questionType;
  const columns = Object.keys(o).filter(k => /^[A-Z]$/u.test(k) && String(o[k]).trim());
  if (!o.options && columns.length) o.options = columns.map(k => ({id:k,text:String(o[k])}));
  if (o.answer !== undefined && o.answerText === undefined) {
    const a=String(o.answer).trim();
    if (['single_choice','multiple_choice'].includes(o.questionType) && Array.isArray(o.options)) {
      const ids=a.split(/[,，、;；\s]+/u).filter(Boolean);
      if (ids.length && ids.every(id => o.options.some(opt => opt.id === id))) { o.answerOptionIds=ids; o.answerText=ids.map(id=>o.options.find(opt=>opt.id===id).text).join('\n'); }
      else o.answerText=a;
    } else if (o.questionType === 'true_false' && booleanLabel(a) !== null) { o.answerBoolean=booleanLabel(a); o.answerText=o.answerBoolean?'正确':'错误'; }
    else if (o.questionType === 'fill_blank' && o.expectedBlankCount && a) {
      const values=a.split('|'); o.answerParts=values.map((v,i)=>({position:i+1,text:v.trim()})); o.answerText=partsText(o.answerParts);
    } else o.answerText=a;
  }
  // Text/table answer declarations are explicit source evidence, but are still structurally checked.
  if (o.answerComplete === undefined && o.answer !== undefined && String(o.answer).trim()) {
    const check=inspectQuestion({...o, answerComplete:true}, 'probe'); o.answerComplete=!check.errors.length;
  }
  return o;
}
function structuredText(value, source) {
  const rows=[];let o={},field='stem';
  const flush=()=>{if(Object.values(o).some(v=>String(v).trim())){for(const k of Object.keys(o))if(typeof o[k]==='string')o[k]=o[k].trim();rows.push(rowObject({...o,sourceName:o.sourceName||`${source} · 题${rows.length+1}`}));}o={};field='stem';};
  for(const raw of value.split(/\r?\n/u)) {
    const line=raw.trimEnd();const m=line.match(/^\s*(题型|题干|题目|答案|解析|空位数|来源)\s*[:：]\s*(.*)$/u);
    if(/^\s*(第\s*\d+\s*题|题号\s*[:：]\s*\d+)\s*$/u.test(line)){flush();continue;}
    if(m){
      const next=aliases[m[1]];
      if((next==='questionType'&&(o.questionType||o.stem))||(next==='stem'&&o.stem?.trim()))flush();
      field=next;o[field]=m[2];continue;
    }
    const option=line.match(/^\s*([A-Z])[.．、)）]\s*(.+)$/u);
    if(option&&['stem','options','questionType'].includes(field)){o[option[1]]=option[2];field='options';continue;}
    if(field!=='options'&&field!=='questionType')o[field]=(o[field]??'')+(o[field]===undefined?'':'\n')+line;
  }
  flush();return rows;
}
async function run() {
  const bytes=Buffer.from(workerData.bytes); const filename=workerData.filename; const format=filename.split('.').pop().toLowerCase();
  let rows=[]; const warnings=[];
  if (['json','jsonl','csv','tsv','txt'].includes(format)) {
    const value=text(bytes); if(value.length>MAX_TEXT) throw new Error('文本超过2MiB解析预算');
    if (format==='json') { const j=JSON.parse(value); rows=Array.isArray(j)?j:j.questions; if(!Array.isArray(rows)) throw new Error('JSON须为题目数组或questions数组'); }
    else if(format==='jsonl') rows=value.split(/\r?\n/u).filter(s=>s.trim()).map(line=>JSON.parse(line));
    else if(['csv','tsv'].includes(format)) rows=parse(value,{columns:true,bom:true,skip_empty_lines:true,delimiter:format==='tsv'?'\t':',',max_record_size:65536}).map(rowObject);
    else { rows=structuredText(value,filename); warnings.push('TXT仅支持带题型/题干/答案/解析标签的规则段落，请逐题核对。'); }
  } else if (format==='xlsx') {
    await zipBudget(bytes); const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(bytes);
    for(const sheet of workbook.worksheets) {
      const headers=sheet.getRow(1).values.slice(1).map(v=>String(v??''));
      sheet.eachRow((row,n)=>{ if(n===1)return; const values={},parseErrors=[]; headers.forEach((h,i)=> { const cell=row.getCell(i+1); if(cell.type===ExcelJS.ValueType.Formula){values[h]='';parseErrors.push(`列${h}含未执行公式，请按原件人工填写`);}else values[h]=cell.text; }); rows.push({...rowObject(values),sourceName:`${filename} · ${sheet.name} · 行${n}`,...(parseErrors.length?{answerComplete:false,$parseErrors:parseErrors}:{})}); });
    }
    warnings.push('仅读取表格文本；不执行公式、宏或外链，图片/公式须人工核对原件。');
  } else if (format==='docx') {
    await zipBudget(bytes); const documentXml=await zipEntry(bytes,'word/document.xml');
    const counted=countedDocx(docxParagraphs(documentXml),filename);
    const extracted=await mammoth.extractRawText({buffer:bytes},{externalFileAccess:false});
    if(extracted.value.length>MAX_TEXT) throw new Error('文档文本超过预算');
    rows=counted??structuredText(extracted.value,filename);
    warnings.push(counted?'DOCX已按带总题数的题型章节和原始段落顺序切分；未见明确答案证据的题目保持未完成，请逐题核对原件。':'DOCX仅规则标签段落；图形、复杂表格、公式未自动解释，保留原件供核对。');
  } else if(format==='pdf') {
    const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:false,disableFontFace:true});
    const pdf=await loading.promise;
    try {
      if(pdf.numPages>200) throw new Error('单任务最多200页'); let count=0;
      for(let page=1;page<=pdf.numPages;page++) {
        const content=await (await pdf.getPage(page)).getTextContent();
        const value=content.items.map(i=>i.str+(i.hasEOL?'\n':' ')).join(''); count+=value.length;
        if(count>MAX_TEXT)throw new Error('PDF文本超过预算');
        if(value.trim())rows.push(...structuredText(value,`${filename} · 页${page}`));
      }
    } finally { await loading.destroy(); }
    if(!rows.length)throw new Error('扫描/图片PDF未检测到文本；当前适配器不做OCR');
    warnings.push('PDF仅文本层与规则标签版式；多栏、公式、图像和阅读顺序必须对照原件核验。');
  } else throw new Error('不支持此格式；当前支持CSV/TSV/JSON/JSONL/TXT/XLSX/DOCX/文本PDF');
  if(rows.length>10000)throw new Error('单次预览最多10000题处理预算，请分文件导入');
  const items=rows.map((row,i)=> { const result=inspectQuestion(row,`q_${i+1}`); return {...result.question,errors:[...result.errors,...(row.$parseErrors||[])]}; });
  return {format,items,warnings};
}
run().then(result=>parentPort.postMessage({result})).catch(error=>parentPort.postMessage({error:error.message}));
