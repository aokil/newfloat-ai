import { createHash, timingSafeEqual } from 'node:crypto';
import { Config, HeaderUtils, SupabaseClient } from 'coze-coding-dev-sdk';
import { getNativeBackend } from '@/lib/native-backend.server';
import { nativeModelBridge } from '@/lib/native-model-bridge.server';
import type { CozeModelMetadata } from '@/lib/coze-llm.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_ID = '7689833705046130729';
const RESPONSE_LIMIT = 128 * 1024;
const PRIVATE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'private, no-store, max-age=0',
  'Pragma': 'no-cache',
  'Expires': '0',
  'X-Content-Type-Options': 'nosniff',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

type Environment = 'DEV' | 'PROD';
type BackendStatus = { ready: boolean; code: string | null; status: 'ok' | null;
  schemaVersion: number | null; storage: 'postgres' | null };
type BackendProbe = { status: BackendStatus; phoneReady: boolean };
type ModelsStatus = { ready: boolean; code: string | null; items: CozeModelMetadata['items'] };
type PhoneStatus = { ready: boolean; code: string | null; backendReady: boolean;
  phone_enabled_supported: boolean; phone_enabled: boolean | null };
type StatusPayload = { projectId: string; environment: Environment | null; ready: boolean;
  identity: { ready: boolean; code: string | null; runtimePlatform: 'cloud' | null };
  backend: BackendStatus; models: ModelsStatus; phone: PhoneStatus };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function authorized(request: Request): boolean {
  const expected = process.env.TIYU_GATEWAY_KEY;
  const supplied = request.headers.get('x-tiyu-gateway-key');
  if (!expected || !/^[\x21-\x7e]{32,512}$/.test(expected) || !supplied ||
    !/^[\x21-\x7e]{32,512}$/.test(supplied)) return false;
  // Compare fixed-size digests so both the value and the configured key length stay private.
  return timingSafeEqual(createHash('sha256').update(expected).digest(),
    createHash('sha256').update(supplied).digest());
}

function notFound(): Response {
  return new Response(JSON.stringify({ error: { code: 'NOT_FOUND', message: '未找到', retryable: false } }),
    { status: 404, headers: PRIVATE_HEADERS });
}

function unavailable(code: string, environment: Environment | null): StatusPayload {
  return { projectId: PROJECT_ID, environment, ready: false,
    identity: { ready: false, code, runtimePlatform: null },
    backend: { ready: false, code, status: null, schemaVersion: null, storage: null },
    models: { ready: false, code, items: [] },
    phone: { ready: false, code, backendReady: false, phone_enabled_supported: false, phone_enabled: null } };
}

function response(value: StatusPayload): Response {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > RESPONSE_LIMIT) {
    // Never truncate a genuine model directory and label the shortened list as complete.
    value.models = { ready: false, code: 'PROVIDER_RESPONSE_TOO_LARGE', items: [] };
    value.ready = false;
  }
  return new Response(JSON.stringify(value), { status: 200, headers: PRIVATE_HEADERS });
}

async function deadline<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('STATUS_TIMEOUT')), timeoutMs);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function backendStatus(): Promise<BackendProbe> {
  const unavailableStatus: BackendStatus = { ready: false, code: 'COZE_BACKEND_UNAVAILABLE',
    status: null, schemaVersion: null, storage: null };
  try {
    return await deadline((async () => {
      const app = await getNativeBackend();
      let phoneReady = false;
      try { phoneReady = app.getDecorator<unknown>('phoneReady') === true; } catch { /* No decorator means not ready. */ }
      const health = await app.inject({ method: 'GET', url: '/health' });
      if (health.statusCode !== 200 || Buffer.byteLength(health.body, 'utf8') > 4_096) {
        return { status: unavailableStatus, phoneReady };
      }
      const value: unknown = JSON.parse(health.body);
      if (!record(value) || value.status !== 'ok' || !Number.isSafeInteger(value.schemaVersion) ||
        typeof value.schemaVersion !== 'number' || value.schemaVersion <= 0) {
        return { status: { ...unavailableStatus, code: 'COZE_BACKEND_HEALTH_INVALID' }, phoneReady };
      }
      if (value.storage !== 'postgres') {
        return { status: { ...unavailableStatus, code: 'COZE_BACKEND_STORAGE_MISMATCH' }, phoneReady };
      }
      return { status: { ready: true, code: null, status: 'ok' as const,
        schemaVersion: value.schemaVersion, storage: 'postgres' as const }, phoneReady };
    })(), 25_000);
  } catch {
    return { status: unavailableStatus, phoneReady: false };
  }
}

async function modelsStatus(): Promise<ModelsStatus> {
  try {
    const metadata = await deadline(nativeModelBridge().metadata(), 22_000);
    if (metadata.projectId !== PROJECT_ID || metadata.environment !== process.env.COZE_PROJECT_ENV || !metadata.items.length) {
      return { ready: false, code: 'PROJECT_IDENTITY_UNAVAILABLE', items: [] };
    }
    return { ready: true, code: null, items: metadata.items };
  } catch (error: unknown) {
    const allowed = new Set(['PROJECT_IDENTITY_UNAVAILABLE', 'COZE_INTEGRATION_NOT_READY',
      'COZE_MODEL_LIST_UNAVAILABLE', 'PROVIDER_RESPONSE_TOO_LARGE']);
    const code = error instanceof Error && allowed.has(error.message) ? error.message : 'COZE_MODEL_LIST_UNAVAILABLE';
    return { ready: false, code, items: [] };
  }
}

async function phoneStatus(config: Config, request: Request): Promise<PhoneStatus> {
  const result: PhoneStatus = { ready: false, code: 'PHONE_AUTH_CONFIG_UNAVAILABLE', backendReady: false,
    phone_enabled_supported: false, phone_enabled: null };
  try {
    const client = new SupabaseClient(config, HeaderUtils.extractForwardHeaders(request.headers));
    const auth = await deadline(client.getAuthConfigV2(), 12_000);
    if (auth.code !== 0 || !auth.config) return result;
    if (auth.config.project_id !== PROJECT_ID) return { ...result, code: 'PROJECT_IDENTITY_UNAVAILABLE' };
    const enabled: unknown = auth.config.phone_config?.external_phone_enabled;
    if (typeof enabled !== 'boolean') return { ...result, code: 'PHONE_AUTH_CONFIG_UNSUPPORTED' };
    return { ...result, code: enabled ? null : 'PHONE_AUTH_DISABLED',
      phone_enabled_supported: true, phone_enabled: enabled };
  } catch {
    return result;
  }
}

export async function GET(request: Request): Promise<Response> {
  // No SDK construction, database initialization or metadata calls before key authentication.
  if (!authorized(request)) return notFound();
  const environment = process.env.COZE_PROJECT_ENV;
  const knownEnvironment = environment === 'DEV' || environment === 'PROD' ? environment : null;
  let config: Config;
  try {
    if (process.env.COZE_PROJECT_ID !== PROJECT_ID || knownEnvironment === null || !nativeModelBridge().ready) {
      return response(unavailable('PROJECT_IDENTITY_UNAVAILABLE', knownEnvironment));
    }
    config = new Config({ timeout: 10_000, retryTimes: 0 });
    config.validate();
    const injectedToken = process.env.COZE_API_TOKEN?.trim() || process.env.COZE_WORKLOAD_IDENTITY_API_KEY?.trim();
    if (!injectedToken || config.apiKey !== injectedToken || config.projectId !== PROJECT_ID ||
      config.runtimePlatform !== 'cloud' || !config.usesUserRuntimeAuth()) {
      return response(unavailable('PROJECT_IDENTITY_UNAVAILABLE', knownEnvironment));
    }
  } catch {
    return response(unavailable('PROJECT_IDENTITY_UNAVAILABLE', knownEnvironment));
  }
  const [backend, models, phone] = await Promise.all([
    backendStatus(), modelsStatus(), phoneStatus(config, request),
  ]);
  phone.backendReady = backend.status.ready && backend.phoneReady;
  phone.ready = phone.backendReady && phone.phone_enabled === true;
  if (!phone.ready && phone.code === null) phone.code = 'PHONE_BACKEND_UNAVAILABLE';
  return response({ projectId: PROJECT_ID, environment: knownEnvironment,
    ready: backend.status.ready && models.ready && phone.ready,
    identity: { ready: true, code: null, runtimePlatform: 'cloud' },
    backend: backend.status, models, phone });
}

/** Avoid Next's automatic HEAD-to-GET fallback starting resource lookups. */
export function HEAD(): Response {
  return notFound();
}
