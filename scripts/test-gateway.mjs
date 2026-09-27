import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createPortProbe } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as gatewayModule from '../src/lib/tiyu-gateway.server.ts';
const { createGateway } = gatewayModule.default || gatewayModule;

const openssl = process.env.OPENSSL_BIN || (process.platform === 'win32'
  ? path.join(process.env.ProgramFiles || '', 'Git', 'usr', 'bin', 'openssl.exe') : 'openssl');
if (process.platform === 'win32' && !existsSync(openssl)) throw new Error('Set OPENSSL_BIN to OpenSSL');
const fixture = mkdtempSync(path.join(tmpdir(), 'tiyu-gateway-test-'));
const run = (...args) => execFileSync(openssl, args, { cwd: fixture, stdio: 'pipe' });
const pem = name => readFileSync(path.join(fixture, name));
const key = 'synthetic-gateway-key-00000000000000000000';
const bearer = 'Bearer synthetic-user-token';
const servers = [];

run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem',
  '-days', '1', '-subj', '/CN=Tiyu Synthetic Test CA', '-addext', 'basicConstraints=critical,CA:TRUE');
for (const [name, ip] of [['valid', '127.0.0.1'], ['wrong-san', '127.0.0.2']]) {
  run('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=synthetic-upstream');
  writeFileSync(path.join(fixture, `${name}.ext`), `subjectAltName=IP:${ip}\nbasicConstraints=critical,CA:FALSE\nextendedKeyUsage=serverAuth\n`);
  run('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', `${name}.pem`, '-days', '1', '-extfile', `${name}.ext`);
}
run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'other.key', '-out', 'other.pem',
  '-days', '1', '-subj', '/CN=Unrelated Synthetic CA', '-addext', 'basicConstraints=critical,CA:TRUE');

async function start(name, handler) {
  const server = createServer({ key: pem(`${name}.key`), cert: pem(`${name}.pem`) }, handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.push(server);
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `https://127.0.0.1:${address.port}`;
}
function waitDrainOrClose(stream) {
  return new Promise(resolve => {
    const drain = () => { stream.off('close', close); resolve(true); };
    const close = () => { stream.off('drain', drain); resolve(false); };
    stream.once('drain', drain);
    stream.once('close', close);
  });
}
const upstreamUrl = await start('valid', async (req, res) => {
  if (req.url === '/v1/hang') return;
  if (req.url === '/v1/redirect-external') {
    res.writeHead(302, { location: 'https://example.invalid/escape' }).end(); return;
  }
  if (req.url === '/v1/redirect-local') {
    res.writeHead(307, { location: `${upstreamUrl}/v1/echo?ok=1` }).end(); return;
  }
  if (req.url === '/v1/download-declared') {
    res.writeHead(200, { 'content-length': 33 * 1024 * 1024 }).end(); return;
  }
  if (req.url === '/v1/download-stream') {
    const chunk = Buffer.alloc(64 * 1024, 120);
    for (let i = 0; i < 530; i++) {
      if (res.destroyed) return;
      if (!res.write(chunk) && !await waitDrainOrClose(res)) return;
    }
    res.end(); return;
  }
  let bytes = 0;
  try { for await (const chunk of req) bytes += chunk.length; } catch { return; }
  res.writeHead(req.url === '/' ? 201 : 200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'content-security-policy': "default-src 'self'",
    'x-tiyu-secret': key,
  });
  res.end(JSON.stringify({ url: req.url, method: req.method, headers: req.headers, bytes }));
});
const env = { TIYU_UPSTREAM_URL: upstreamUrl, TIYU_UPSTREAM_CA_B64: pem('ca.pem').toString('base64'), TIYU_GATEWAY_KEY: key };
const gateway = createGateway(env);
const request = (pathname = '/', init = {}) => new Request(`https://synthetic.coze.site${pathname}`, init);
function streamOf(bytes) {
  return new ReadableStream({ pull(controller) {
    if (bytes <= 0) { controller.close(); return; }
    const size = Math.min(bytes, 64 * 1024);
    bytes -= size;
    controller.enqueue(new Uint8Array(size));
  } });
}

try {
  await test('TLS CA and SAN verified; status, CSP and static cache preserved', async () => {
    const result = await gateway(request());
    assert.equal(result.status, 201);
    assert.equal(result.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(result.headers.get('cache-control'), 'public, max-age=300');
    assert.equal(result.headers.get('content-security-policy'), "default-src 'self'");
    assert.equal(result.headers.get('x-tiyu-secret'), null);
    assert.equal((await result.json()).url, '/');
  });
  await test('Bearer and gateway key preserved; spoofed IP and cookies removed; account no-store', async () => {
    const result = await gateway(request('/v1/echo?url=https://example.invalid', { headers: {
      authorization: bearer, 'x-forwarded-for': '8.8.8.8', forwarded: 'for=8.8.8.8', 'x-real-ip': '8.8.8.8',
      'x-tiyu-client-ip': '8.8.8.8', 'x-tiyu-gateway-key': 'client-spoof', cookie: 'session=spoof',
      'idempotency-key': 'synthetic-operation-id',
    } }));
    const data = await result.json();
    assert.equal(data.headers.authorization, bearer);
    assert.equal(data.headers['x-tiyu-gateway-key'], key);
    assert.equal(data.headers['idempotency-key'], 'synthetic-operation-id');
    for (const name of ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-tiyu-client-ip', 'cookie']) assert.equal(data.headers[name], undefined);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(data.url, '/v1/echo?url=https://example.invalid');
  });
  await test('10 MiB multipart upload streams intact', async () => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(10 * 1024 * 1024)]), 'synthetic.txt');
    const result = await gateway(request('/v1/upload', { method: 'POST', body: form }));
    assert.equal(result.status, 200);
    const data = await result.json();
    assert.ok(data.bytes > 10 * 1024 * 1024 && data.bytes < 10 * 1024 * 1024 + 4096);
    assert.match(data.headers['content-type'], /^multipart\/form-data; boundary=/);
  });
  await test('12 MiB limit covers declared and chunked uploads', async () => {
    const declared = await gateway(request('/v1/upload', { method: 'POST', headers: { 'content-length': `${13 * 1024 * 1024}` }, body: 'x' }));
    assert.equal(declared.status, 413);
    assert.deepEqual((await declared.json()).error, { code: 'UPLOAD_TOO_LARGE', message: '请求暂时无法完成', retryable: false });
    const chunked = await gateway(request('/v1/upload', { method: 'POST', body: streamOf(13 * 1024 * 1024), duplex: 'half' }));
    assert.equal(chunked.status, 413);
    const mismatch = await gateway(request('/v1/upload', { method: 'POST', headers: { 'content-length': '1' }, body: 'too long' }));
    assert.equal(mismatch.status, 400);
  });
  await test('unconfigured or invalid targets fail closed; disallowed paths stay local', async () => {
    for (const url of [undefined, 'http://127.0.0.1', 'https://example.invalid', `${upstreamUrl}/path`, `${upstreamUrl}?url=x`, 'https://user:password@127.0.0.1']) {
      const result = await createGateway({ ...env, TIYU_UPSTREAM_URL: url })(request());
      assert.equal(result.status, 503);
      const text = await result.text();
      assert.match(text, /题屿/);
      assert.ok(!text.includes(key));
    }
    for (const pathname of ['/admin', '/v1/a%2fb', '/v1/a%5cb', '/v1/a%0db', '//example.invalid/']) {
      assert.equal((await gateway(request(pathname))).status, 404);
    }
  });
  await test('wrong CA and wrong IP SAN cannot connect; failures contain no sensitive detail', async () => {
    const wrongSan = await start('wrong-san', (_req, res) => res.end('must not arrive'));
    for (const settings of [{ ...env, TIYU_UPSTREAM_CA_B64: pem('other.pem').toString('base64') }, { ...env, TIYU_UPSTREAM_URL: wrongSan }]) {
      const result = await createGateway(settings)(request('/v1/echo', { headers: { authorization: bearer } }));
      assert.equal(result.status, 502);
      const text = await result.text();
      for (const secret of [key, bearer, upstreamUrl, 'CERT', '127.0.0.1']) assert.ok(!text.includes(secret));
    }
  });
  await test('external redirects rejected; fixed-upstream redirect rewritten to same origin', async () => {
    assert.equal((await gateway(request('/v1/redirect-external'))).status, 502);
    const local = await gateway(request('/v1/redirect-local'));
    assert.equal(local.status, 307);
    assert.equal(local.headers.get('location'), '/v1/echo?ok=1');
    await local.text();
  });
  await test('download limit rejects declared size and aborts oversized streaming response', async () => {
    assert.equal((await gateway(request('/v1/download-declared'))).status, 502);
    const streamed = await gateway(request('/v1/download-stream'));
    assert.equal(streamed.status, 200);
    await assert.rejects(streamed.arrayBuffer(), /Response transfer interrupted/);
  });
  await test('deadline and user cancellation terminate upstream requests', async () => {
    const timed = await createGateway(env, { timeoutMs: 100, idleTimeoutMs: 100 })(request('/v1/hang'));
    assert.equal(timed.status, 504);
    assert.deepEqual((await timed.json()).error, { code: 'UPSTREAM_TIMEOUT', message: '请求暂时无法完成', retryable: true });
    const controller = new AbortController();
    const pending = gateway(request('/v1/hang', { signal: controller.signal }));
    setTimeout(() => controller.abort(), 50);
    assert.equal((await pending).status, 499);
    const body = await gateway(request('/v1/download-stream'));
    await body.body.cancel();
  });
  if (process.argv.includes('--next')) {
    await test('built Next server routes root/assets/API and streams a 10 MiB upload over HTTP', async () => {
      const probe = createPortProbe();
      probe.listen(0, '127.0.0.1');
      await once(probe, 'listening');
      const address = probe.address();
      assert.ok(address && typeof address !== 'string');
      const port = address.port;
      await new Promise(resolve => probe.close(resolve));
      const child = spawn(process.execPath, ['dist/server.js'], {
        cwd: process.cwd(), env: { ...process.env, ...env, COZE_PROJECT_ENV: 'PROD', HOSTNAME: '127.0.0.1', PORT: String(port) },
        windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      });
      // Drain framework stderr without ever including tokens, bodies or configuration in test output.
      child.stderr.resume();
      try {
        const base = `http://127.0.0.1:${port}`;
        let ready = false;
        for (let i = 0; i < 100; i++) {
          if (child.exitCode !== null) throw new Error('Next server exited during startup');
          try {
            const result = await fetch(base + '/health');
            ready = result.status === 200;
            await result.arrayBuffer();
            if (ready) break;
          } catch { /* wait for the local server to bind */ }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(ready, 'Next server did not become ready');
        for (const pathname of ['/', '/app.js', '/style.css', '/brandmark.svg', '/health', '/v1/me']) {
          const result = await fetch(base + pathname, { headers: { authorization: bearer } });
          assert.equal(result.status, pathname === '/' ? 201 : 200);
          assert.equal(result.headers.get('cache-control'), 'no-store');
          assert.equal((await result.json()).url, pathname);
        }
        assert.equal((await fetch(base + '/unavailable')).status, 404);
        const form = new FormData();
        form.append('file', new Blob([new Uint8Array(10 * 1024 * 1024)]), 'synthetic.txt');
        const result = await fetch(base + '/v1/upload', { method: 'POST', headers: { authorization: bearer }, body: form });
        assert.equal(result.status, 200);
        assert.ok((await result.json()).bytes > 10 * 1024 * 1024);
      } finally {
        child.kill();
        await once(child, 'exit');
      }
    });
  }
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  })));
  const resolved = path.resolve(fixture);
  if (path.dirname(resolved) === path.resolve(tmpdir()) && path.basename(resolved).startsWith('tiyu-gateway-test-')) {
    rmSync(resolved, { recursive: true, force: true });
  }
}
