import test from 'node:test';
import assert from 'node:assert/strict';
import {answerKind,minimalAnswer} from '../src/answer-only.js';
import {parseModelAnswer} from '../src/model-answer.js';

const stem='判断 长期服用依赖性精神药品成瘾尚未戒除的，将被注销驾驶证。';
const question=`${stem}\nA. 正确\nB. 错误`;

test('model truth answers are valid without changing the input question classification',()=>{
  assert.equal(answerKind(question),'choice');
  for(const [raw,expected] of [['对','对'],['错','错'],['正确','对'],['错误','错'],['true','对'],['false','错'],['✓','对'],['✗','错']])
    assert.equal(minimalAnswer(parseModelAnswer(JSON.stringify({answer:raw})).answer,question),expected);
  assert.equal(minimalAnswer(parseModelAnswer('{"answer":false}').answer,question),'错');
});
test('judgment letters follow actual option meanings even when order and labels differ',()=>{
  const reversed=`题型：判断题\n${stem}\nC. 错误\nE. 正确`;
  assert.equal(minimalAnswer('C',reversed),'错');
  assert.equal(minimalAnswer('E',reversed),'对');
  assert.equal(minimalAnswer('e',reversed),'对');
  assert.throws(()=>minimalAnswer('A',reversed),/INVALID_ANSWER/u);
  assert.equal(minimalAnswer('Ａ',`题型：判断题\n${stem}\nＡ．错误\nＢ．正确`),'错');
});
test('explicit choice requests accept truth answers and keep literal choice letters unchanged',()=>{
  const explicit=`题型：单选题\n${stem}\nA. 错误\nB. 正确`;
  assert.equal(answerKind(explicit),'choice');
  assert.equal(minimalAnswer('对',explicit),'对');
  assert.equal(minimalAnswer('错',explicit),'错');
  assert.equal(minimalAnswer('B',explicit),'B');
  assert.throws(()=>minimalAnswer('AB',explicit),/INVALID_ANSWER/u);
});
test('the app type header accepts judgments independently of visible option labels',()=>{
  const explicit=`题型：判断题\n${question}`;
  assert.equal(minimalAnswer('对',explicit),'对');
  assert.equal(minimalAnswer('B',explicit),'错');
  assert.equal(minimalAnswer('错',`题型：判断题\n${stem}`),'错');
  assert.throws(()=>minimalAnswer('B',`题型：判断题\n${stem}`),/INVALID_ANSWER/u);
});
test('truth answers remain valid data while ambiguous letters and prose remain invalid',()=>{
  for(const body of ['A. 北京\nB. 上海','A. 正确\nB. 对','A. 是\nB. 否','A. 正确\nA. 错误',
    'A. 正确\nB. 错误\nC. 正确','A. 正确\nB. 错误\n额外说明']) {
    const input=`题目\n${body}`;
    assert.equal(answerKind(input),'choice');
    assert.equal(minimalAnswer('对',input),'对');
  }
  for(const answer of ['可能正确','对，因为……',''])assert.throws(()=>minimalAnswer(answer,question),/INVALID_ANSWER/u);
  assert.throws(()=>minimalAnswer('A',`题型：判断题\n题目\nA. 正确\nA. 错误`),/INVALID_ANSWER/u);
});
test('text questions and ordinary multiple-choice normalization retain their existing behavior',()=>{
  assert.equal(minimalAnswer('北京','题型：简答题\n题目\nA. 正确\nB. 错误'),'北京');
  assert.equal(minimalAnswer('b、a','题型：多选题\n题目\nA. 北京\nB. 上海'),'A、B');
});
