import { createHash, timingSafeEqual } from 'node:crypto';
import { Config, HeaderUtils, SupabaseClient } from 'coze-coding-dev-sdk';
import { getNativeBackend, nativeBackendFailure } from '@/lib/native-backend.server';
import { nativeModelBridge } from '@/lib/native-model-bridge.server';
import type { CozeModelMetadata } from '@/lib/coze-llm.server';
import { cozeIntegrationFailure, cozeModelMetadataFailure, verifiedCozeProjectRuntimeContext,
  cozeRuntimeIdentityDiagnostics } from '@/lib/coze-llm.server';
import type { CozeIntegrationFailure, CozeRuntimeIdentityDiagnostics } from '@/lib/coze-llm.server';
import { diagnoseWorkloadProjectEnvFailure, getInjectedProjectResources,
  workloadRuntimeStatus } from '@/lib/coze-workload.server';

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
  schemaVersion: number | null; storage: 'postgres' | null;
  initialization?: ReturnType<typeof nativeBackendFailure> };
type BackendProbe = { status: BackendStatus; phoneReady: boolean };
type ModelsStatus = { ready: boolean; code: string | null; items: CozeModelMetadata['items'];
  source?: CozeModelMetadata['source']; retrievedAt?: string | null;
  generationVerified?: false;
  diagnostics?: CozeIntegrationFailure | null };
type PhoneStatus = { ready: boolean; code: string | null; backendReady: boolean;
  phone_enabled_supported: boolean; phone_enabled: boolean | null;
  diagnostics?: CozeIntegrationFailure | { stage: string; businessCode: number } };
type StatusPayload = { projectId: string; environment: Environment | null; ready: boolean;
  identity: { ready: boolean; code: string | null; runtimePlatform: 'cloud' | 'local' | null;
    credentialSource?: 'workload-token' | 'project-token'; scopedDatabaseInjected?: boolean;
    scopedPhoneInjected?: boolean; verification?: 'devbox' | 'production-workload';
    diagnostics: CozeRuntimeIdentityDiagnostics };
  backend: BackendStatus; models: ModelsStatus; phone: PhoneStatus;
  workload?: ReturnType<typeof workloadRuntimeStatus> };

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
    identity: { ready: false, code, runtimePlatform: null, diagnostics: cozeRuntimeIdentityDiagnostics() },
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
    return { status: { ...unavailableStatus, initialization: nativeBackendFailure() }, phoneReady: false };
  }
}

async function modelsStatus(): Promise<ModelsStatus> {
  try {
    const metadata = await deadline(nativeModelBridge().metadata(), 22_000);
    if (metadata.projectId !== PROJECT_ID || metadata.environment !== process.env.COZE_PROJECT_ENV || !metadata.items.length) {
      return { ready: false, code: 'PROJECT_IDENTITY_UNAVAILABLE', items: [] };
    }
    return { ready: true, code: null, items: metadata.items, source: metadata.source,
      retrievedAt: metadata.retrievedAt, generationVerified: false };
  } catch (error: unknown) {
    const allowed = new Set(['PROJECT_IDENTITY_UNAVAILABLE', 'COZE_INTEGRATION_NOT_READY',
      'COZE_MODEL_LIST_UNAVAILABLE', 'PROVIDER_RESPONSE_TOO_LARGE']);
    const code = error instanceof Error && allowed.has(error.message) ? error.message : 'COZE_MODEL_LIST_UNAVAILABLE';
    return { ready: false, code, items: [], diagnostics: cozeModelMetadataFailure() };
  }
}

async function phoneStatus(config: Config, request: Request): Promise<PhoneStatus> {
  const result: PhoneStatus = { ready: false, code: 'PHONE_AUTH_CONFIG_UNAVAILABLE', backendReady: false,
    phone_enabled_supported: false, phone_enabled: null };
  try {
    const client = new SupabaseClient(config, HeaderUtils.extractForwardHeaders(request.headers));
    const auth = await deadline(client.getAuthConfigV2(), 12_000);
    if (auth.code !== 0 || !auth.config) return typeof auth.code === 'number' && Number.isSafeInteger(auth.code)
      ? { ...result, diagnostics: { stage: 'phone-configuration', businessCode: auth.code } } : result;
    // The SDK normalizes this ID from Config. This is a context sanity check,
    // not an independent assertion about the upstream resource's ownership.
    if (auth.config.project_id !== PROJECT_ID) return { ...result, code: 'PROJECT_IDENTITY_UNAVAILABLE' };
    const enabled: unknown = auth.config.phone_config?.external_phone_enabled;
    if (typeof enabled !== 'boolean') return { ...result, code: 'PHONE_AUTH_CONFIG_UNSUPPORTED' };
    return { ...result, code: enabled ? null : 'PHONE_AUTH_DISABLED',
      phone_enabled_supported: true, phone_enabled: enabled };
  } catch (error: unknown) {
    return { ...result, diagnostics: cozeIntegrationFailure(error, 'phone-configuration') };
  }
}

export async function GET(request: Request): Promise<Response> {
  // No SDK construction, database initialization or metadata calls before key authentication.
  if (!authorized(request)) return notFound();
  const expiresAt = Date.now() + 25_000;
  const environment = process.env.COZE_PROJECT_ENV;
  const knownEnvironment = environment === 'DEV' || environment === 'PROD' ? environment : null;
  let config: Config;
  let credentialSource: 'workload-token' | 'project-token';
  let runtimeIdentity: 'devbox' | 'production-workload';
  try {
    if (process.env.COZE_PROJECT_ID !== PROJECT_ID || knownEnvironment === null || !nativeModelBridge().ready) {
      return response(unavailable('PROJECT_IDENTITY_UNAVAILABLE', knownEnvironment));
    }
    ({ config, credentialSource, runtimeIdentity } = await deadline(verifiedCozeProjectRuntimeContext(),
      Math.max(1, expiresAt - Date.now())));
  } catch (error: unknown) {
    // Explicit owner diagnostics, after gateway authentication and genuine SDK failure.
    // Keep sampling within the original status deadline; never authorize from its result.
    if (knownEnvironment === 'PROD' && new URL(request.url).searchParams.get('workload-response') === '1' &&
      expiresAt - Date.now() >= 2_100) {
      try { await deadline(diagnoseWorkloadProjectEnvFailure(), Math.max(1, expiresAt - Date.now())); }
      catch { /* Preserve the original unavailable result. */ }
    }
    const code = error instanceof Error && error.message === 'STATUS_TIMEOUT' ? 'COZE_BACKEND_STATUS_TIMEOUT'
      : error instanceof Error && error.message === 'MODEL_AUTH_UNAVAILABLE' ? 'COZE_RUNTIME_AUTH_UNAVAILABLE'
      : 'PROJECT_IDENTITY_UNAVAILABLE';
    return response({ ...unavailable(code, knownEnvironment),
      workload: workloadRuntimeStatus() });
  }
  const runtimePlatform = config.runtimePlatform;
  if (runtimePlatform !== 'cloud' && runtimePlatform !== 'local') {
    return response(unavailable('PROJECT_IDENTITY_UNAVAILABLE', knownEnvironment));
  }
  const identity: StatusPayload['identity'] = { ready: true, code: null, runtimePlatform,
    credentialSource, verification: runtimeIdentity, diagnostics: cozeRuntimeIdentityDiagnostics(),
    scopedDatabaseInjected: Boolean(getInjectedProjectResources()?.databaseUrl),
    scopedPhoneInjected: Boolean(getInjectedProjectResources()?.phoneConfiguration) };
  let probes: [BackendProbe, ModelsStatus, PhoneStatus];
  try {
    probes = await deadline(Promise.all([backendStatus(), modelsStatus(), phoneStatus(config, request)]),
      Math.max(1, expiresAt - Date.now()));
  } catch {
    return response({ ...unavailable('COZE_BACKEND_STATUS_TIMEOUT', knownEnvironment), identity,
      workload: workloadRuntimeStatus() });
  }
  const [backend, models, phone] = probes;
  phone.backendReady = backend.status.ready && backend.phoneReady;
  phone.ready = phone.backendReady && phone.phone_enabled === true;
  if (!phone.ready && phone.code === null) phone.code = 'PHONE_BACKEND_UNAVAILABLE';
  return response({ projectId: PROJECT_ID, environment: knownEnvironment,
    ready: backend.status.ready && models.ready && phone.ready,
    identity,
    backend: backend.status, models, phone, workload: workloadRuntimeStatus() });
}

/** Avoid Next's automatic HEAD-to-GET fallback starting resource lookups. */
export function HEAD(): Response {
  return notFound();
}
