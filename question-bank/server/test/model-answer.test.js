import test from 'node:test';
import assert from 'node:assert/strict';
import {parseModelAnswer,modelText} from '../src/model-answer.js';

test('valid concise model replies are accepted with or without JSON wrappers',()=>{
  for(const reply of ['C','答案：C','"C"','{"answer":"C"}','```json\n{"answer":"C"}\n```'])
    assert.deepEqual(parseModelAnswer(reply),{answer:'C',explanation:''});
  assert.equal(parseModelAnswer('{"answer":false}').answer,'错');
  assert.equal(parseModelAnswer('3.14').answer,'3.14');
  assert.equal(parseModelAnswer('12345678901234567890').answer,'12345678901234567890');
  assert.equal(parseModelAnswer('{"answer":["A","C"],"explanation":null}').answer,'A、C');
  assert.equal(parseModelAnswer('{"answer":"C","analysis":"不展示的说明"}').explanation,'');
});
test('missing answers and broken structured replies remain failures',()=>{
  assert.throws(()=>parseModelAnswer('{"answer":""}'),/EMPTY_RESPONSE/u);
  assert.throws(()=>parseModelAnswer('无法识别图片中的题目'),/EMPTY_RESPONSE/u);
  assert.throws(()=>parseModelAnswer('{"answer":'),/INVALID_ANSWER/u);
  assert.throws(()=>parseModelAnswer('{"other":"C"}'),/INVALID_ANSWER/u);
  assert.throws(()=>parseModelAnswer('{"answer":{"nested":"C"}}'),/INVALID_ANSWER/u);
});
test('usage-only chunks do not invalidate the completed text answer',()=>{
  assert.equal(modelText(undefined),'');assert.equal(modelText(null),'');
  assert.equal(modelText([{type:'text',text:'C'},{type:'thinking'}]),'C');
  assert.equal(modelText([{type:'output_text',text:'C'}]),'C');
  assert.throws(()=>modelText([{type:'image_url',image_url:{url:'not-answer-text'}}]),/INVALID_ANSWER/u);
});
