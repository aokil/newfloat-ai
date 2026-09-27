import { timingSafeEqual } from 'node:crypto';

type Environment = Record<string, string | undefined>;
const PRIVATE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'X-Robots-Tag': 'noindex, nofollow',
};

function authorized(request: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 32 || expected.length > 512 || /[^\x21-\x7e]/.test(expected)) return false;
  const supplied = request.headers.get('x-tiyu-gateway-key');
  if (supplied === null || supplied.length !== expected.length) return false;
  const actualBytes = Buffer.from(supplied, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function publicKey(key: string): boolean {
  if (key.length > 8192 || /[\u0000-\u0020\u007f]/.test(key)) return false;
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(key)) return true;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    const [headerPart, payloadPart] = key.split('.');
    const header: unknown = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    // This classifies a configured public key; it does not authenticate a JWT user.
    return record(header) && ['HS256', 'RS256', 'ES256'].includes(String(header.alg)) &&
      record(payload) && payload.role === 'anon';
  } catch {
    return false;
  }
}

function error(status: number): Response {
  return Response.json({ error: {
    code: status === 404 ? 'NOT_FOUND' : 'SERVICE_NOT_READY',
    message: status === 404 ? '未找到' : '服务暂未就绪',
    retryable: status === 503,
  } }, { status, headers: PRIVATE_HEADERS });
}

/** Uses only this process's platform-injected configuration; never provisions resources. */
export function createPhoneConfigHandler(env: Environment = process.env) {
  return async function handler(request: Request): Promise<Response> {
    // Authenticate before inspecting or disclosing any platform configuration.
    if (!authorized(request, env.TIYU_GATEWAY_KEY)) return error(404);
    try {
      const projectId = env.COZE_PROJECT_ID || '';
      const environment = env.COZE_PROJECT_ENV || '';
      const configuredUrl = env.COZE_SUPABASE_URL || '';
      const anonKey = env.COZE_SUPABASE_ANON_KEY || '';
      if (!projectId || /[^0-9]/.test(projectId) || !['DEV', 'PROD'].includes(environment) ||
        configuredUrl.length > 2048 || /[\u0000-\u0020\u007f]/.test(configuredUrl) || !publicKey(anonKey)) return error(503);
      const url = new URL(configuredUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return error(503);
      return Response.json({ projectId, environment, url: url.origin, anonKey }, { headers: PRIVATE_HEADERS });
    } catch {
      // Do not serialize environment values, parser errors or underlying exceptions.
      return error(503);
    }
  };
}

export const phoneConfig = createPhoneConfigHandler();
