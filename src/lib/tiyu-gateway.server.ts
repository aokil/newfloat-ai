import { X509Certificate } from 'node:crypto';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';

const UPLOAD_LIMIT = 12 * 1024 * 1024;
const DOWNLOAD_LIMIT = 32 * 1024 * 1024;
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const STATIC_PATHS = new Set([
  '/', '/app.js', '/style.css', '/brandmark.svg', '/health',
  '/workspace.js', '/workspace.css', '/ui-assets.js',
  '/assets/avatars/pinterest-01.jpg', '/assets/avatars/pinterest-02.jpg',
  '/assets/avatars/pinterest-03.jpg', '/assets/avatars/pinterest-04.jpg',
  '/assets/avatars/pinterest-05.jpg', '/assets/avatars/pinterest-06.jpg',
  '/assets/avatars/sources.json', '/assets/model-icons-license.txt',
]);
const REQUEST_HEADERS = ['accept', 'accept-language', 'content-type', 'content-length',
  'if-none-match', 'if-modified-since', 'range', 'if-range', 'idempotency-key'];
const RESPONSE_HEADERS = ['content-type', 'content-length', 'content-disposition',
  'content-security-policy', 'content-security-policy-report-only', 'cache-control',
  'etag', 'last-modified', 'expires', 'vary', 'retry-after', 'www-authenticate',
  'accept-ranges', 'content-range', 'x-content-type-options', 'referrer-policy',
  'x-frame-options', 'permissions-policy', 'ratelimit-limit', 'ratelimit-remaining',
  'ratelimit-reset', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset'];

type GatewayEnvironment = Record<string, string | undefined>;
type GatewayOptions = { timeoutMs?: number; idleTimeoutMs?: number };
type Configuration = { upstream: URL; ca: string; key: string };

class GatewayError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
  }
}

function configuration(env: GatewayEnvironment): Configuration {
  try {
    const upstream = new URL(env.TIYU_UPSTREAM_URL || '');
    // An operator-selected IP only: no DNS rebinding, user-selected host, or base path.
    if (upstream.protocol !== 'https:' || !isIP(upstream.hostname.replace(/^\[|\]$/g, '')) ||
      upstream.username || upstream.password || upstream.search || upstream.hash || upstream.pathname !== '/') {
      throw new Error('invalid configuration');
    }
    const encoded = env.TIYU_UPSTREAM_CA_B64 || '';
    if (encoded.length > 32768 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('invalid CA');
    const ca = Buffer.from(encoded, 'base64').toString('utf8');
    if (!ca.startsWith('-----BEGIN CERTIFICATE-----') || !new X509Certificate(ca).ca) throw new Error('invalid CA');
    const key = env.TIYU_GATEWAY_KEY || '';
    if (!/^[\x21-\x7e]{32,512}$/.test(key)) throw new Error('invalid key');
    return { upstream, ca, key };
  } catch {
    throw new GatewayError(503, 'SERVICE_NOT_READY');
  }
}

function allowedPath(pathname: string): boolean {
  // All existing IDs are ASCII. Reject escaped separators, traversal and header controls.
  return STATIC_PATHS.has(pathname) ||
    (/^\/v1(?:\/[A-Za-z0-9_.-]+)*\/?$/.test(pathname) &&
      !pathname.split('/').some(segment => segment === '.' || segment === '..'));
}

function failure(request: Request, error: GatewayError): Response {
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'" };
  const body = new URL(request.url).pathname === '/' && error.status === 503
    ? '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>题屿</title><main><h1>题屿</h1><p>服务暂未就绪，请稍后重试。</p></main></html>'
    : JSON.stringify({ error: { code: error.code,
      message: error.status === 503 ? '服务暂未就绪' : '请求暂时无法完成',
      retryable: error.status >= 500,
    } });
  return new Response(request.method === 'HEAD' ? null : body, {
    status: error.status,
    headers: { ...headers, 'Content-Type': body.startsWith('<!') ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8' },
  });
}

function contentLength(value: string | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new GatewayError(400, 'INVALID_LENGTH');
  return Number(value);
}

/** Factory arguments are used only by local integration tests; routes use server env. */
export function createGateway(env: GatewayEnvironment = process.env, options: GatewayOptions = {}) {
  return async function proxy(request: Request): Promise<Response> {
    const incomingUrl = new URL(request.url);
    if (!allowedPath(incomingUrl.pathname)) return failure(request, new GatewayError(404, 'NOT_FOUND'));
    if (!METHODS.has(request.method)) return failure(request, new GatewayError(405, 'METHOD_NOT_ALLOWED'));
    let config: Configuration;
    try {
      config = configuration(env);
      if ((contentLength(request.headers.get('content-length')) || 0) > UPLOAD_LIMIT) throw new GatewayError(413, 'UPLOAD_TOO_LARGE');
      const encoding = request.headers.get('content-encoding');
      if (encoding && encoding !== 'identity') throw new GatewayError(415, 'UNSUPPORTED_ENCODING');
      if (request.signal.aborted) throw new GatewayError(499, 'REQUEST_CANCELLED');
    } catch (error) {
      return failure(request, error instanceof GatewayError ? error : new GatewayError(502, 'UPSTREAM_UNAVAILABLE'));
    }

    const headers: Record<string, string> = { 'accept-encoding': 'identity', 'x-tiyu-gateway-key': config.key };
    for (const name of REQUEST_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const authorization = request.headers.get('authorization');
    if (authorization?.startsWith('Bearer ') && authorization.length <= 8192) headers.authorization = authorization;
    // An allowlist deliberately excludes cookies, Host, Origin, Forwarded, XFF,
    // X-Real-IP and every client-supplied internal/gateway header.
    const target = new URL(config.upstream);
    target.pathname = incomingUrl.pathname;
    target.search = incomingUrl.search;

    let upstreamResponse: IncomingMessage | undefined;
    let failureReason: GatewayError | undefined;
    let finished = false;
    const reader = request.body?.getReader();
    const upstream = httpsRequest(target, {
      method: request.method, headers, ca: config.ca, rejectUnauthorized: true,
      // Standard TLS hostname/IP SAN verification stays enabled. Do not override it.
      agent: false, maxHeaderSize: 32 * 1024,
    });
    const stop = (error: GatewayError) => {
      failureReason ??= error;
      upstreamResponse?.destroy(error);
      upstream.destroy(error);
      void reader?.cancel().catch(() => {});
    };
    const onAbort = () => stop(new GatewayError(499, 'REQUEST_CANCELLED'));
    request.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => stop(new GatewayError(504, 'UPSTREAM_TIMEOUT')), options.timeoutMs ?? 120_000);
    upstream.setTimeout(options.idleTimeoutMs ?? 30_000, () => stop(new GatewayError(504, 'UPSTREAM_TIMEOUT')));
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request.signal.removeEventListener('abort', onAbort);
    };
    // Attach listeners before starting the body, including when TLS fails before a response.
    const responseReady = new Promise<IncomingMessage>((resolve, reject) => {
      upstream.once('response', response => {
        upstreamResponse = response;
        // Keep the stream paused until the downstream pulls. This also observes errors
        // while a large upload is still finishing, avoiding an unhandled event.
        response.on('error', () => {});
        resolve(response);
      });
      upstream.on('error', () => reject(failureReason ?? new GatewayError(502, 'UPSTREAM_UNAVAILABLE')));
    });
    const upload = async () => {
      let bytes = 0;
      const expected = contentLength(request.headers.get('content-length'));
      try {
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > UPLOAD_LIMIT) throw new GatewayError(413, 'UPLOAD_TOO_LARGE');
            if (expected !== undefined && bytes > expected) throw new GatewayError(400, 'INVALID_LENGTH');
            // Waiting for each write callback bounds memory and honors socket backpressure.
            await new Promise<void>((resolve, reject) => {
              upstream.write(value, error => error ? reject(error) : resolve());
            });
          }
        }
        if (failureReason) throw failureReason;
        if (expected !== undefined && expected !== bytes) throw new GatewayError(400, 'INVALID_LENGTH');
        upstream.end();
      } catch (error) {
        const reason = error instanceof GatewayError ? error : failureReason ?? new GatewayError(502, 'UPSTREAM_UNAVAILABLE');
        stop(reason);
        throw reason;
      } finally {
        reader?.releaseLock();
      }
    };

    try {
      const [response] = await Promise.all([responseReady, upload()]);
      if (failureReason) throw failureReason;
      const status = response.statusCode || 502;
      if ((contentLength(response.headers['content-length']) || 0) > DOWNLOAD_LIMIT) throw new GatewayError(502, 'DOWNLOAD_TOO_LARGE');
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw new GatewayError(502, 'UNEXPECTED_ENCODING');
      const responseHeaders = new Headers();
      for (const name of RESPONSE_HEADERS) {
        const value = response.headers[name];
        if (typeof value === 'string') responseHeaders.set(name, value);
      }
      const location = response.headers.location;
      if (location) {
        const redirect = new URL(location, target);
        // Never follow or expose an upstream/third-party host in a browser redirect.
        if (redirect.origin !== target.origin || !allowedPath(redirect.pathname) || redirect.username || redirect.password) throw new GatewayError(502, 'UNSAFE_REDIRECT');
        responseHeaders.set('location', redirect.pathname + redirect.search + redirect.hash);
      }
      if (incomingUrl.pathname.startsWith('/v1') || request.headers.has('authorization')) {
        responseHeaders.set('cache-control', 'no-store');
      }
      if (request.method === 'HEAD' || [204, 205, 304].includes(status)) {
        response.resume();
        cleanup();
        return new Response(null, { status, headers: responseHeaders });
      }
      const iterator = response[Symbol.asyncIterator]();
      let received = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const { value, done } = await iterator.next();
            if (done) {
              cleanup();
              controller.close();
              return;
            }
            const chunk: Uint8Array = value;
            received += chunk.byteLength;
            if (received > DOWNLOAD_LIMIT) throw new GatewayError(502, 'DOWNLOAD_TOO_LARGE');
            controller.enqueue(chunk);
          } catch (error) {
            stop(error instanceof GatewayError ? error : failureReason ?? new GatewayError(502, 'UPSTREAM_UNAVAILABLE'));
            cleanup();
            // Headers may already be sent: fail the stream, never append a fake success.
            controller.error(new Error('Response transfer interrupted'));
          }
        },
        cancel() {
          stop(new GatewayError(499, 'REQUEST_CANCELLED'));
          cleanup();
        },
      }, { highWaterMark: 64 * 1024, size: chunk => chunk.byteLength });
      return new Response(body, { status, headers: responseHeaders });
    } catch (error) {
      const reason = error instanceof GatewayError ? error : failureReason ?? new GatewayError(502, 'UPSTREAM_UNAVAILABLE');
      stop(reason);
      cleanup();
      return failure(request, reason);
    }
  };
}

export const proxyRequest = createGateway();
