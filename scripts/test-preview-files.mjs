import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import * as previewModule from '../src/lib/tiyu-preview.server.ts';

const { createPreviewFileServer } = previewModule.default || previewModule;
const publicRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../question-bank/server/public');
const dev = createPreviewFileServer({ NODE_ENV: 'development', COZE_PROJECT_ENV: 'DEV' }, publicRoot);
const request = (pathname = '/', method = 'GET') => new Request(`https://synthetic.dev.coze.site${pathname}`, { method });

await test('DEV reads the real committed page and all resources without upstream configuration', async () => {
  const files = [
    ['/', 'index.html', 'text/html; charset=utf-8'],
    ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
    ['/style.css', 'style.css', 'text/css; charset=utf-8'],
    ['/brandmark.svg', 'brandmark.svg', 'image/svg+xml'],
    ['/workspace.js', 'workspace.js', 'text/javascript; charset=utf-8'],
    ['/workspace.css', 'workspace.css', 'text/css; charset=utf-8'],
    ['/ui-assets.js', 'ui-assets.js', 'text/javascript; charset=utf-8'],
    ...Array.from({ length: 6 }, (_, i) => {
      const file = `assets/avatars/pinterest-0${i + 1}.jpg`;
      return [`/${file}`, file, 'image/jpeg'];
    }),
    ['/assets/avatars/sources.json', 'assets/avatars/sources.json', 'application/json; charset=utf-8'],
    ['/assets/model-icons-license.txt', 'assets/model-icons-license.txt', 'text/plain; charset=utf-8'],
  ];
  for (const [pathname, filename, contentType] of files) {
    const expected = await readFile(path.join(publicRoot, filename));
    const response = await dev(request(pathname));
    assert.ok(response, pathname);
    assert.equal(response.status, 200, pathname);
    assert.equal(response.headers.get('content-type'), contentType, pathname);
    assert.equal(response.headers.get('content-length'), String(expected.byteLength), pathname);
    assert.equal(response.headers.get('cache-control'), 'no-store', pathname);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', pathname);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, pathname);
  }
  const root = await dev(request('/'));
  const csp = root.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /frame-ancestors/);
  assert.equal(root.headers.get('x-frame-options'), null);
});

await test('HEAD preserves MIME and length but returns no response body', async () => {
  for (const pathname of ['/', '/workspace.js', '/assets/avatars/pinterest-01.jpg']) {
    const get = await dev(request(pathname));
    const head = await dev(request(pathname, 'HEAD'));
    assert.ok(head);
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal(head.body, null);
  }
});

await test('PROD always falls through; DEV marker also supports a production-built preview', async () => {
  for (const nodeEnv of ['development', 'production', undefined]) {
    const production = createPreviewFileServer({ NODE_ENV: nodeEnv, COZE_PROJECT_ENV: 'PROD' }, publicRoot);
    assert.equal(await production(request('/')), null);
    assert.equal(await production(request('/workspace.js')), null);
  }
  assert.equal(await createPreviewFileServer({ NODE_ENV: 'production' }, publicRoot)(request('/')), null);
  const markedDev = createPreviewFileServer({ NODE_ENV: 'production', COZE_PROJECT_ENV: 'DEV' }, publicRoot);
  assert.equal((await markedDev(request('/'))).status, 200);
});

await test('APIs, health, source files, arbitrary paths and non-read methods are not intercepted', async () => {
  for (const pathname of ['/v1/me', '/v1/auth/login', '/health', '/internal/phone-config', '/index.html',
    '/.env', '/package.json', '/question-bank/server/src/main.js', '/app.js/',
    '/assets/avatars/pinterest-07.jpg', '/assets/avatars/sources.json/extra',
    '/assets%2favatars%2fpinterest-01.jpg', '/assets/avatars/%2e%2e%2f%2e%2e%2fpackage.json',
    '/assets/avatars/pinterest-01.jpg%00', '//example.invalid/app.js']) {
    assert.equal(await dev(request(pathname)), null, pathname);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal(await dev(request('/', method)), null, method);
    assert.equal(await dev(request('/app.js', method)), null, method);
  }
});

await test('a missing committed file returns an honest safe 503 including for HEAD', async () => {
  const missing = createPreviewFileServer({ COZE_PROJECT_ENV: 'DEV' }, path.join(publicRoot, 'missing-preview-fixture'));
  const response = await missing(request('/'));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.text();
  assert.equal(JSON.parse(body).error.code, 'PREVIEW_FILE_UNAVAILABLE');
  assert.ok(!body.includes(publicRoot));
  assert.ok(!body.includes('ENOENT'));
  const head = await missing(request('/', 'HEAD'));
  assert.equal(head.status, 503);
  assert.equal(head.body, null);
});
