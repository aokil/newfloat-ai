import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDatabaseEnvironment, ensureSupabaseEnvironment } from 'coze-coding-dev-sdk';
import type { SupabaseEnvironment } from 'coze-coding-dev-sdk';
import { nativeModelBridge } from './native-model-bridge.server';
import { verifiedCozeProjectRuntimeContext } from './coze-llm.server';
import { getInjectedProjectResources, getWorkloadProjectResources } from './coze-workload.server';

const PROJECT_ID = '7689833705046130729';
const STATE_KEY = Symbol.for('float-ai.native-backend.7689833705046130729.v1');
type BackendFailure = { stage: string; code: string | null; httpStatus: number | null };
type BackendState = { backend?: Promise<FastifyInstance>; retryAt: number; closing?: Promise<void>;
  failure?: BackendFailure; runtimeBindingHash?: string };
const processGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: BackendState };
// The HTTP entry and Next route chunks bundle this module independently.
// A process-wide symbol keeps their requests and diagnostics on one instance.
const state = processGlobal[STATE_KEY] ??= { retryAt: 0 };

/** Only fixed codes/numeric status; SDK errors can contain credentials. */
function safeFailure(error: unknown, stage: string): BackendFailure {
  const result: BackendFailure = { stage, code: null, httpStatus: null };
  const codes = new Set(['ENOTFOUND', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET',
    'ERR_MODULE_NOT_FOUND', 'ERR_INVALID_URL', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', '28P01', '28000', '3D000',
    '42501', '42P01', '42703', '23505', '23514', '22003', '40001', '40P01',
    'COZE_PROJECT_IDENTITY_UNAVAILABLE', 'COZE_BACKEND_MODULE_UNAVAILABLE',
    'COZE_DATABASE_UNAVAILABLE', 'COZE_RUNTIME_KEY_UNAVAILABLE']);
  if (error && typeof error === 'object') {
    if ('code' in error && typeof error.code === 'string' && codes.has(error.code)) result.code = error.code;
    if (error instanceof Error && codes.has(error.message)) result.code = error.message;
    if ('statusCode' in error && typeof error.statusCode === 'number' && Number.isInteger(error.statusCode) &&
      error.statusCode >= 100 && error.statusCode <= 599) result.httpStatus = error.statusCode;
    if ('status' in error && typeof error.status === 'number' && Number.isInteger(error.status) &&
      error.status >= 400 && error.status <= 599) result.httpStatus = error.status;
    if ('response' in error && error.response && typeof error.response === 'object' &&
      'status' in error.response && typeof error.response.status === 'number' &&
      Number.isInteger(error.response.status) && error.response.status >= 400 && error.response.status <= 599)
      result.httpStatus = error.response.status;
  }
  return result;
}

export function nativeBackendFailure(): BackendFailure | null {
  return state.failure ? { ...state.failure } : null;
}
type NativeFactory = (options: { databaseUrl: string; phoneConfiguration?: SupabaseEnvironment;
  cozeBridge: ReturnType<typeof nativeModelBridge> }) => Promise<FastifyInstance>;

/** Freeze the instance's project, phase, credential and resource binding in memory. */
function runtimeBindingHash(): string {
  const names = ['COZE_PROJECT_ID', 'COZE_PROJECT_ENV', 'COZE_DEVBOX_ENV', 'PROJECT_PATH', 'COZE_WORKSPACE_PATH',
    'COZE_API_TOKEN', 'COZE_WORKLOAD_IDENTITY_API_KEY', 'COZE_WORKLOAD_IDENTITY_CLIENT_ID',
    'COZE_WORKLOAD_IDENTITY_CLIENT_SECRET', 'COZE_WORKLOAD_IDENTITY_TOKEN_ENDPOINT',
    'COZE_WORKLOAD_ACCESS_TOKEN_ENDPOINT', 'COZE_OUTBOUND_AUTH_ENDPOINT', 'TIYU_GATEWAY_KEY',
    'BOOTSTRAP_ADMIN_PHONE', 'PGDATABASE_URL_DEV', 'PGDATABASE_URL_PROD', 'TIYU_SUPABASE_URL_DEV',
    'TIYU_SUPABASE_URL_PROD', 'TIYU_SUPABASE_ANON_KEY_DEV', 'TIYU_SUPABASE_ANON_KEY_PROD'];
  return createHash('sha256').update(JSON.stringify(names.map(name => [name, process.env[name] ?? null]))).digest('hex');
}

function bindingChanged(): Promise<never> {
  state.failure = { stage: 'runtime-binding', code: 'COZE_PROJECT_IDENTITY_UNAVAILABLE', httpStatus: null };
  return Promise.reject(new Error('COZE_BACKEND_UNAVAILABLE'));
}

/** One shared backend per process, using only this project's DEV or PROD DB. */
export function getNativeBackend(): Promise<FastifyInstance> {
  const currentBinding = runtimeBindingHash();
  // Never switch an existing or in-flight backend to another identity/database.
  if ((state.runtimeBindingHash && state.runtimeBindingHash !== currentBinding) ||
    (state.backend && !state.runtimeBindingHash)) return bindingChanged();
  if (state.closing) return Promise.reject(new Error('COZE_BACKEND_UNAVAILABLE'));
  if (state.backend) return state.backend;
  if (Date.now() < state.retryAt) return Promise.reject(new Error('COZE_BACKEND_UNAVAILABLE'));
  let stage = 'identity';
  state.backend = (async () => {
    if (process.env.COZE_PROJECT_ID !== PROJECT_ID || !['DEV', 'PROD'].includes(process.env.COZE_PROJECT_ENV || ''))
      throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    const bridge = nativeModelBridge();
    // Validate the platform identity without mutating global SDK credentials.
    if (!bridge.ready) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    // The SDK's first Config construction can load the platform .env. Freeze
    // the validated configuration before the first asynchronous operation.
    const authorizedBinding = runtimeBindingHash();
    if (state.runtimeBindingHash && state.runtimeBindingHash !== authorizedBinding)
      throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    state.runtimeBindingHash ??= authorizedBinding;
    stage = 'runtime-authorization';
    // PROD has no DEVBOX marker. Require actual official workload authorization
    // and phase-resource binding before any database initialization.
    await verifiedCozeProjectRuntimeContext();
    if (runtimeBindingHash() !== authorizedBinding) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    const injectedResources = getInjectedProjectResources();
    stage = 'workload-resources';
    const workloadResources = injectedResources?.databaseUrl && injectedResources.phoneConfiguration
      ? null : await getWorkloadProjectResources();
    stage = 'database-configuration';
    // SDK 0.7.32 checks .env only; Coze may inject the scoped URL into the
    // process instead. Prefer that official DEV/PROD variable before ensuring.
    const injectedDatabaseUrl = injectedResources?.databaseUrl ||
      workloadResources?.databaseUrl;
    const database = injectedDatabaseUrl
      ? { databaseUrl: injectedDatabaseUrl, context: { projectId: PROJECT_ID } }
      : await ensureDatabaseEnvironment();
    if (database.context.projectId !== PROJECT_ID) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    // Authentication may be temporarily unavailable; the website and database
    // remain usable, while SMS APIs return their genuine unavailable state.
    const phoneConfiguration = injectedResources?.phoneConfiguration || workloadResources?.phoneConfiguration;
    const phone = phoneConfiguration
      ? { ...phoneConfiguration, context: { root: process.cwd(), projectId: PROJECT_ID } }
      : await ensureSupabaseEnvironment().catch(() => undefined);
    if (phone && phone.context.projectId !== PROJECT_ID) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    // Keep the existing ESM backend unbundled: parser workers and public files
    // resolve their own import.meta.url in both preview and production.
    stage = 'module-load';
    const loaded: unknown = await import(/* webpackIgnore: true */ pathToFileURL(path.resolve(process.cwd(), 'question-bank/server/src/coze-runtime.js')).href);
    if (!loaded || typeof loaded !== 'object' || !('createCozeApp' in loaded) || typeof loaded.createCozeApp !== 'function')
      throw new Error('COZE_BACKEND_MODULE_UNAVAILABLE');
    const createCozeApp = loaded.createCozeApp as NativeFactory;
    if (runtimeBindingHash() !== authorizedBinding) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    stage = 'business-initialization';
    const app = await createCozeApp({ databaseUrl: database.databaseUrl,
      phoneConfiguration: phone, cozeBridge: bridge });
    if (runtimeBindingHash() !== authorizedBinding) {
      await app.close().catch(() => undefined);
      throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    }
    state.failure = undefined;
    return app;
  })().catch((error: unknown) => {
    state.failure = safeFailure(error, stage);
    state.backend = undefined;
    state.retryAt = Date.now() + 10_000;
    // SDK/database errors may contain connection credentials. Never serialize.
    throw new Error('COZE_BACKEND_UNAVAILABLE');
  });
  return state.backend;
}

export async function nativeHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const app = await getNativeBackend();
    app.server.emit('request', req, res);
  } catch {
    res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'COZE_BACKEND_UNAVAILABLE',
      message: 'Coze 业务服务暂未就绪，请稍后重试。', retryable: true } }));
  }
}

export async function closeNativeBackend(): Promise<void> {
  if (state.closing) return state.closing;
  const pending = state.backend;
  if (!pending) return;
  state.closing = (async () => { await (await pending).close(); })();
  return state.closing;
}
