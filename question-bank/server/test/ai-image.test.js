import test from 'node:test';
import assert from 'node:assert/strict';
import {modelSupportsImages,validateAiImage,aiImageDigest,aiImageUrl,AI_IMAGE_LIMIT} from '../src/ai-image.js';

const image={mimeType:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/xGQAAAAASUVORK5CYII='};
test('image capability uses real model IDs and explicit metadata, not price labels',()=>{
  assert.equal(modelSupportsImages('doubao-seed-2-0-mini-260215'),true);
  assert.equal(modelSupportsImages('qwen-3-5-plus-260215'),true);
  assert.equal(modelSupportsImages('glm-4-7-251222'),false);
  assert.equal(modelSupportsImages('doubao-mini'),false);
  assert.equal(modelSupportsImages('unknown'),false);
  assert.equal(modelSupportsImages('doubao-seed-2-0-pro-260215',['text']),false);
  assert.equal(modelSupportsImages('other-real-vision-model',['text','image']),true);
});
test('bounded inline images do not accept remote URLs or claimed dimensions',()=>{
  assert.deepEqual(validateAiImage(image),image);
  assert.equal(aiImageUrl(image),`data:image/png;base64,${image.data}`);
  assert.match(aiImageDigest(image),/^[0-9a-f]{64}$/u);
  assert.throws(()=>validateAiImage({...image,url:'https://example.invalid/private.png'}));
  assert.throws(()=>validateAiImage({...image,data:`data:image/png;base64,${image.data}`}));
  assert.throws(()=>validateAiImage({...image,mimeType:'image/svg+xml'}));
  assert.throws(()=>validateAiImage({...image,data:'A'.repeat(Math.ceil(AI_IMAGE_LIMIT/3)*4+4)}));
  const oversized=Buffer.from(image.data,'base64');oversized.writeUInt32BE(99999,16);
  assert.throws(()=>validateAiImage({...image,data:oversized.toString('base64')}));
});
