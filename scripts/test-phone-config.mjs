import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import test from 'node:test';
import * as configModule from '../src/lib/phone-config.server.ts';

const { createPhoneConfigHandler } = configModule.default || configModule;
const gatewayKey = 'synthetic-phone-config-gateway-key-000000000000';
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (role, alg = 'HS256') => `${encode({ alg, typ: 'JWT' })}.${encode({ role, ref: 'synthetic-only' })}.${Buffer.from('synthetic-signature').toString('base64url')}`;
const synthetic = {
  TIYU_GATEWAY_KEY: gatewayKey,
  COZE_PROJECT_ID: '7689833705046130729',
  COZE_PROJECT_ENV: 'PROD',
  COZE_SUPABASE_URL: 'https://synthetic-auth.example.invalid',
  COZE_SUPABASE_ANON_KEY: jwt('anon'),
  SUPABASE_SERVICE_ROLE_KEY: 'must-never-be-returned',
};
const request = (key = gatewayKey) => new Request('https://synthetic.coze.site/internal/phone-config', {
  headers: key === undefined ? {} : { 'x-tiyu-gateway-key': key },
});
const noStore = response => assert.match(response.headers.get('cache-control') || '', /\bno-store\b/);

await test('missing, wrong and oversized gateway keys all return opaque 404', async () => {
  const handler = createPhoneConfigHandler(synthetic);
  for (const key of ['', 'x'.repeat(gatewayKey.length), 'x'.repeat(4096)]) {
    const response = await handler(request(key));
    assert.equal(response.status, 404);
    noStore(response);
    const body = await response.text();
    for (const forbidden of [gatewayKey, synthetic.COZE_SUPABASE_ANON_KEY, synthetic.COZE_SUPABASE_URL, synthetic.COZE_PROJECT_ID]) assert.ok(!body.includes(forbidden));
  }
  assert.equal((await handler(new Request('https://synthetic.coze.site/internal/phone-config'))).status, 404);
  assert.equal((await createPhoneConfigHandler({ ...synthetic, TIYU_GATEWAY_KEY: undefined })(request())).status, 404);
});

await test('authorized response contains only exact current project/environment and public configuration', async () => {
  for (const environment of ['DEV', 'PROD']) {
    const response = await createPhoneConfigHandler({ ...synthetic, COZE_PROJECT_ENV: environment })(request());
    assert.equal(response.status, 200);
    noStore(response);
    assert.deepEqual(await response.json(), { projectId: synthetic.COZE_PROJECT_ID, environment,
      url: synthetic.COZE_SUPABASE_URL, anonKey: synthetic.COZE_SUPABASE_ANON_KEY });
  }
  const publishable = 'sb_publishable_synthetic_public_key_0123456789';
  const response = await createPhoneConfigHandler({ ...synthetic, COZE_SUPABASE_ANON_KEY: publishable })(request());
  assert.equal((await response.json()).anonKey, publishable);
});

await test('missing platform configuration fails closed and never falls back to unrelated env names', async () => {
  for (const key of ['COZE_PROJECT_ID', 'COZE_PROJECT_ENV', 'COZE_SUPABASE_URL', 'COZE_SUPABASE_ANON_KEY']) {
    const response = await createPhoneConfigHandler({ ...synthetic, [key]: undefined,
      SUPABASE_URL: synthetic.COZE_SUPABASE_URL, SUPABASE_ANON_KEY: synthetic.COZE_SUPABASE_ANON_KEY })(request());
    assert.equal(response.status, 503);
    noStore(response);
    assert.deepEqual(await response.json(), { error: { code: 'SERVICE_NOT_READY', message: '服务暂未就绪', retryable: true } });
  }
});

await test('service role, secret keys, malformed and unsigned JWTs are refused', async () => {
  for (const key of [jwt('service_role'), jwt('authenticated'), jwt('anon', 'none'),
    'sb_secret_synthetic_privileged_key_0123456789', 'sb_publishable_short', 'not-a-jwt', 'aaa.bbb.ccc',
    'sb_publishable_synthetic_public_key_0123456789\n', jwt('anon') + '\nINJECTED=1']) {
    const response = await createPhoneConfigHandler({ ...synthetic, COZE_SUPABASE_ANON_KEY: key })(request());
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(key));
  }
});

await test('non-HTTPS, credentials, path, query and fragment in configured URL are refused', async () => {
  for (const url of ['http://synthetic.invalid', 'https://user:password@synthetic.invalid',
    'https://synthetic.invalid/path', 'https://synthetic.invalid/?key=private', 'https://synthetic.invalid/#private', 'invalid',
    'https://synthetic.invalid\n', 'https://synthetic.\ninvalid', ' https://synthetic.invalid']) {
    const response = await createPhoneConfigHandler({ ...synthetic, COZE_SUPABASE_URL: url })(request());
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(url));
  }
});

if (process.argv.includes('--next')) {
  await test('production Next selects internal route over catch-all and enforces authentication', async () => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const address = probe.address();
    assert.ok(address && typeof address !== 'string');
    const port = address.port;
    await new Promise(resolve => probe.close(resolve));
    const child = spawn(process.execPath, ['dist/server.js'], {
      cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, ...synthetic, HOSTNAME: '127.0.0.1', PORT: String(port),
        TIYU_UPSTREAM_URL: '', TIYU_UPSTREAM_CA_B64: '' },
    });
    child.stderr.resume();
    try {
      const base = `http://127.0.0.1:${port}`;
      let ready = false;
      for (let i = 0; i < 100; i++) {
        if (child.exitCode !== null) throw new Error('Next server exited during startup');
        try {
          const response = await fetch(base + '/internal/phone-config');
          ready = response.status === 404;
          await response.arrayBuffer();
          if (ready) break;
        } catch { /* the local server has not bound its port yet */ }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(ready, 'Next server did not become ready');
      const response = await fetch(base + '/internal/phone-config', { headers: { 'x-tiyu-gateway-key': gatewayKey } });
      assert.equal(response.status, 200);
      noStore(response);
      const payload = await response.json();
      assert.equal(payload.projectId, synthetic.COZE_PROJECT_ID);
      assert.equal(payload.environment, 'PROD');
      assert.equal(payload.anonKey, synthetic.COZE_SUPABASE_ANON_KEY);
      assert.equal((await fetch(base + '/internal/phone-config', { headers: { 'x-tiyu-gateway-key': 'wrong' } })).status, 404);
      assert.equal((await fetch(base + '/internal/unknown')).status, 404);
      assert.equal((await fetch(base + '/health')).status, 503);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
  });
}
