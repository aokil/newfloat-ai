import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@coze/workload-identity';
import { diagnoseWorkloadEnvResponse } from './coze-workload-response-diagnostics.server';
import type { WorkloadEnvResponseDiagnostics } from './coze-workload-response-diagnostics.server';

const PROJECT_ID = '7689833705046130729';
const FAILURE_COOLDOWN_MS = 10_000;
const RESOURCE_CACHE_MS = 60_000;
const REQUIRED_ENV = [
  'COZE_WORKLOAD_IDENTITY_CLIENT_ID',
  'COZE_WORKLOAD_IDENTITY_CLIENT_SECRET',
  'COZE_WORKLOAD_IDENTITY_TOKEN_ENDPOINT',
  'COZE_WORKLOAD_ACCESS_TOKEN_ENDPOINT',
  'COZE_OUTBOUND_AUTH_ENDPOINT',
] as const;
const ENDPOINT_ENV = [
  'COZE_WORKLOAD_IDENTITY_TOKEN_ENDPOINT',
  'COZE_WORKLOAD_ACCESS_TOKEN_ENDPOINT',
  'COZE_OUTBOUND_AUTH_ENDPOINT',
] as const;

type Phase = 'DEV' | 'PROD';
type Stage = 'idle' | 'loading' | 'ready' | 'cooldown' | 'blocked';
type Operation = 'idle' | 'construct' | 'access-token' | 'project-env' | 'parse' | 'binding';
type FailureReason = 'missing-project' | 'missing-environment' | 'permission' |
  'unsupported-runtime' | 'configuration-not-found' | 'invalid-parameter' | 'other';
type ErrorType = 'ConfigurationError' | 'TokenRetrievalError' | 'TokenExchangeError' |
  'WorkloadIdentityError' | 'NetworkError' | 'APIError' | 'Error';
type EndpointFormat = { parseable: boolean; httpOrHttps: boolean; noCredentials: boolean;
  noQuery: boolean; noHash: boolean; trailingSlash: boolean; endsWithEnv: boolean };
export type WorkloadProjectResources = {
  databaseUrl?: string;
  phoneConfiguration?: { supabaseUrl: string; anonKey: string };
  projectApiToken?: string;
};
export type WorkloadRuntimeStatus = {
  environment: Record<(typeof REQUIRED_ENV)[number], boolean>;
  stage: Stage;
  httpStatus: number | null;
  errorType: ErrorType | null;
  operation: Operation;
  accessTokenVerified: boolean;
  failureReason: FailureReason | null;
  businessCode: number | null;
  endpoints: Record<(typeof ENDPOINT_ENV)[number], EndpointFormat>;
  laneConfigured: boolean;
  lane: { kind: 'none' | 'boe' | 'ppe' | 'custom'; hasOuterWhitespace: boolean;
    clientMatchesCurrent: boolean | null };
  responseDiagnostics?: WorkloadEnvResponseDiagnostics;
  resources: { database: boolean; phone: boolean; projectApiToken: boolean };
  productionConfigurationAccepted: boolean;
  productionBindingVerified: boolean;
};
type SharedState = {
  identityHash?: string;
  phase?: Phase;
  client?: Client;
  clientLane?: string;
  responseProbeAttempted?: boolean;
  responseDiagnostics?: WorkloadEnvResponseDiagnostics;
  productionConfigurationHash?: string;
  resources?: WorkloadProjectResources;
  expiresAt: number;
  pending?: Promise<WorkloadProjectResources | null>;
  retryAt: number;
  stage: Stage;
  httpStatus: number | null;
  errorType: ErrorType | null;
  // Optional for an already initialized v1 global state during a DEV hot reload.
  operation?: Operation;
  accessTokenVerified?: boolean;
  failureReason?: FailureReason | null;
  businessCode?: number | null;
};
const STATE_KEY = Symbol.for('float-ai/coze-workload-resources/v1');
const sharedGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: SharedState };
const state = sharedGlobal[STATE_KEY] ??= {
  expiresAt: 0, retryAt: 0, stage: 'idle', httpStatus: null, errorType: null,
  operation: 'idle', accessTokenVerified: false, failureReason: null, businessCode: null,
};

// The SDK token cache is process-wide. A changed identity requires a fresh process;
// constructing another Client cannot safely switch the cached workload identity.
function identityFingerprint(): string {
  const identityEnvironment = [...REQUIRED_ENV, 'COZE_PROJECT_ID', 'COZE_PROJECT_ENV',
    'COZE_API_TOKEN', 'COZE_WORKLOAD_IDENTITY_API_KEY', 'COZE_SERVER_ENV'];
  return createHash('sha256').update(JSON.stringify(identityEnvironment.map((name) =>
    [name, process.env[name] ?? null]))).digest('hex');
}

function phase(): Phase | null {
  const environment = process.env.COZE_PROJECT_ENV;
  if (process.env.COZE_PROJECT_ID !== PROJECT_ID || (environment !== 'DEV' && environment !== 'PROD')) return null;
  if (process.env.COZE_DEVBOX_ENV?.trim()) return environment;
  // A production runtime may omit the DEVBOX marker. This permits
  // resource verification only; it does not itself authenticate the runtime.
  const workloadToken = process.env.COZE_WORKLOAD_IDENTITY_API_KEY?.trim();
  const projectToken = process.env.COZE_API_TOKEN?.trim();
  return environment === 'PROD' && Boolean(workloadToken) &&
    (!projectToken || projectToken === workloadToken) &&
    REQUIRED_ENV.every(name => Boolean(process.env[name]?.trim())) ? 'PROD' : null;
}

function environmentPresence(): WorkloadRuntimeStatus['environment'] {
  return Object.fromEntries(REQUIRED_ENV.map((name) => [name, Boolean(process.env[name]?.trim())])) as
    WorkloadRuntimeStatus['environment'];
}

function endpointFormat(value: string | undefined): EndpointFormat {
  const flags: EndpointFormat = { parseable: false, httpOrHttps: false, noCredentials: false,
    noQuery: false, noHash: false, trailingSlash: false, endsWithEnv: false };
  if (!value || value.length > 8192) return flags;
  try {
    const url = new URL(value);
    return { parseable: true, httpOrHttps: url.protocol === 'http:' || url.protocol === 'https:',
      noCredentials: !url.username && !url.password,
      noQuery: !url.href.includes('?'), noHash: !url.href.includes('#'),
      trailingSlash: url.pathname.endsWith('/'), endsWithEnv: url.pathname.endsWith('/env') };
  } catch { return flags; }
}

function endpointFormats(): WorkloadRuntimeStatus['endpoints'] {
  return Object.fromEntries(ENDPOINT_ENV.map(name => [name, endpointFormat(process.env[name])])) as
    WorkloadRuntimeStatus['endpoints'];
}

function laneStatus(): WorkloadRuntimeStatus['lane'] {
  const lane = process.env.COZE_SERVER_ENV ?? 'NONE';
  const kind = !lane || lane === 'NONE' ? 'none' : lane.startsWith('boe_') ? 'boe' :
    lane.startsWith('ppe_') ? 'ppe' : 'custom';
  return { kind, hasOuterWhitespace: lane.trim() !== lane,
    clientMatchesCurrent: state.client ? state.clientLane === lane : null };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Classify only upstream text inside the SDK's fixed error templates.
 * Never retain that text, endpoint URLs, response bodies or token descriptions. */
function upstreamFailureReason(message: string): FailureReason {
  const value = message.toLowerCase();
  const missing = /\b(?:missing|required|not\s+provided|not\s+found|empty)\b|缺少|缺失|未提供|不存在|为空/.test(value);
  if ((/\b(?:project_id|project[ _-]id)\b|项目(?:id|标识)/.test(value) && missing) ||
    /\bmissing\s+project\b(?!\s+(?:env|environment))|\bproject\s+(?:is\s+)?(?:missing|required|not\s+found)\b|缺少项目|项目缺失/.test(value))
    return 'missing-project';
  if (/\b(?:environment|project_env|projectenv|project_environment|env)\b|环境/.test(value) && missing)
    return 'missing-environment';
  if (/\b(?:permission|forbidden|unauthorized|insufficient_scope|access\s+denied|not\s+allowed)\b|无权限|没有权限|权限不足|禁止访问|未授权/.test(value))
    return 'permission';
  if ((/\b(?:runtime|platform)\b|运行时|运行环境|平台/.test(value)) &&
    /\b(?:unsupported|not\s+supported)\b|不支持/.test(value)) return 'unsupported-runtime';
  if (/\b(?:configuration|config|secret|secrets)\b|配置|密钥/.test(value) &&
    /\b(?:not\s+found|missing|unavailable|does\s+not\s+exist)\b|未找到|不存在|缺失|未配置/.test(value))
    return 'configuration-not-found';
  if (/\b(?:invalid|malformed|bad)\s+(?:request|parameter|parameters|param|argument|arguments)\b|\b(?:parameter|parameters|param|argument|arguments)\b.*\b(?:invalid|malformed|required)\b|参数错误|参数无效|参数不合法|缺少参数/.test(value))
    return 'invalid-parameter';
  return 'other';
}

function failureDetails(error: unknown): Pick<WorkloadRuntimeStatus,
  'httpStatus' | 'errorType' | 'failureReason' | 'businessCode'> {
  const result: Pick<WorkloadRuntimeStatus, 'httpStatus' | 'errorType' | 'failureReason' | 'businessCode'> =
    { httpStatus: null, errorType: null, failureReason: 'other', businessCode: null };
  if (!record(error)) return result;
  const names: readonly string[] = ['ConfigurationError', 'TokenRetrievalError', 'TokenExchangeError',
    'WorkloadIdentityError', 'NetworkError', 'APIError', 'Error'];
  if (typeof error.name === 'string' && names.includes(error.name)) result.errorType = error.name as ErrorType;
  for (const value of [error.statusCode, error.status, record(error.response) ? error.response.status : null]) {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599)
      result.httpStatus = value;
  }
  // This SDK exposes some HTTP failures only through fixed message templates.
  // Retain the numeric status alone; never return the message or response body.
  if (typeof error.message === 'string' && error.message.length <= 8192) {
    const message = error.message;
    if (result.httpStatus === null) {
      const matched = message.match(/\b(?:HTTP |request failed with status )([1-5]\d{2})\b/);
      if (matched) result.httpStatus = Number(matched[1]);
    }
    const apiError = message.match(/^(?:Project environment variables|Integration credential) API error: code=(-?\d{1,15}), msg=([\s\S]*)$/);
    if (apiError) {
      const code = Number(apiError[1]);
      if (Number.isSafeInteger(code)) result.businessCode = code;
      result.failureReason = upstreamFailureReason(apiError[2]);
    } else {
      const httpError = message.match(/^(?:Client|Server) error \([1-5]\d{2}\): (?:Project environment variables|Integration credential) request failed with status [1-5]\d{2}: ([\s\S]*)$/);
      const tokenError = message.match(/^Token request failed: ([\s\S]*)$/);
      const upstream = httpError?.[1] ?? tokenError?.[1];
      if (upstream !== undefined) result.failureReason = upstreamFailureReason(upstream);
    }
  }
  return result;
}

function databaseUrl(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 8192 || /[\u0000-\u0020\u007f]/.test(candidate)) return undefined;
  try {
    const url = new URL(candidate);
    return (url.protocol === 'postgres:' || url.protocol === 'postgresql:') && url.hostname && !url.hash ?
      candidate : undefined;
  } catch { return undefined; }
}

function publicAnonKey(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 8192 || /[\u0000-\u0020\u007f]/.test(candidate)) return undefined;
  if (/^sb_publishable_[A-Za-z0-9_-]{16,}$/.test(candidate)) return candidate;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(candidate)) return undefined;
  try {
    const [headerPart, payloadPart] = candidate.split('.');
    const header: unknown = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
    const payload: unknown = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
    return record(header) && ['HS256', 'RS256', 'ES256'].includes(String(header.alg)) &&
      record(payload) && payload.role === 'anon' ? candidate : undefined;
  } catch { return undefined; }
}

function phoneConfiguration(urlValue: string | undefined, keyValue: string | undefined):
  WorkloadProjectResources['phoneConfiguration'] {
  const candidate = urlValue?.trim();
  const anonKey = publicAnonKey(keyValue);
  if (!candidate || candidate.length > 2048 || /[\u0000-\u0020\u007f]/.test(candidate) || !anonKey) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/') return undefined;
    return { supabaseUrl: url.origin, anonKey };
  } catch { return undefined; }
}

function copyResources(resources: WorkloadProjectResources): WorkloadProjectResources {
  return { ...resources, ...(resources.phoneConfiguration ?
    { phoneConfiguration: { ...resources.phoneConfiguration } } : {}) };
}

/** Read only phase-scoped configuration injected into the fixed Coze cloud project. */
export function getInjectedProjectResources(): WorkloadProjectResources | null {
  const currentPhase = phase();
  if (!currentPhase) return null;
  const configuredDatabase = databaseUrl(process.env[`PGDATABASE_URL_${currentPhase}`]);
  const configuredPhone = phoneConfiguration(process.env[`TIYU_SUPABASE_URL_${currentPhase}`],
    process.env[`TIYU_SUPABASE_ANON_KEY_${currentPhase}`]);
  if (!configuredDatabase && !configuredPhone) return null;
  return {
    ...(configuredDatabase ? { databaseUrl: configuredDatabase } : {}),
    ...(configuredPhone ? { phoneConfiguration: configuredPhone } : {}),
  };
}

/** Trust the owner's audited Coze deployment configuration, not local metadata
 * as a remote resource-ownership assertion. No DEV/general resource fallback. */
function productionConfigurationHash(): string | null {
  const workloadToken = process.env.COZE_WORKLOAD_IDENTITY_API_KEY?.trim();
  const projectToken = process.env.COZE_API_TOKEN?.trim();
  const injected = getInjectedProjectResources();
  if (phase() !== 'PROD' || !workloadToken || (projectToken && projectToken !== workloadToken) ||
    !REQUIRED_ENV.every(name => Boolean(process.env[name]?.trim())) ||
    !injected?.databaseUrl || !injected.phoneConfiguration ||
    (state.identityHash !== undefined && state.identityHash !== identityFingerprint()) ||
    (state.phase !== undefined && state.phase !== 'PROD')) return null;
  const resources = ['PGDATABASE_URL_PROD', 'TIYU_SUPABASE_URL_PROD', 'TIYU_SUPABASE_ANON_KEY_PROD',
    'COZE_DEVBOX_ENV', 'PROJECT_PATH', 'COZE_WORKSPACE_PATH', 'TIYU_GATEWAY_KEY', 'BOOTSTRAP_ADMIN_PHONE'];
  return createHash('sha256').update(JSON.stringify([identityFingerprint(),
    ...resources.map(name => [name, process.env[name] ?? null])])).digest('hex');
}

/** Freeze the complete platform-injected PROD binding before asynchronous use.
 * This does not call /env or establish remote model/resource authorization;
 * SMS authentication and genuine model connection tests remain independent. */
export function acceptProductionInjectedResources(): boolean {
  const hash = productionConfigurationHash();
  if (!hash || (state.productionConfigurationHash !== undefined && state.productionConfigurationHash !== hash))
    return false;
  state.productionConfigurationHash ??= hash;
  return true;
}

function productionConfigurationAccepted(): boolean {
  const hash = productionConfigurationHash();
  return hash !== null && state.productionConfigurationHash === hash;
}

/** A process that accepted PROD cannot later serve a DEV/model identity. */
export function productionConfigurationUnchanged(): boolean {
  return state.productionConfigurationHash === undefined || productionConfigurationAccepted();
}

function resourceBindingsMatch(left: WorkloadProjectResources | null | undefined,
  right: WorkloadProjectResources | null | undefined): boolean {
  if (!left?.databaseUrl || !left.phoneConfiguration?.supabaseUrl || !left.phoneConfiguration.anonKey ||
    !right?.databaseUrl || !right.phoneConfiguration?.supabaseUrl || !right.phoneConfiguration.anonKey) return false;
  const digest = (resources: WorkloadProjectResources): Buffer => createHash('sha256').update(JSON.stringify([
    resources.databaseUrl, resources.phoneConfiguration?.supabaseUrl, resources.phoneConfiguration?.anonKey,
  ])).digest();
  return timingSafeEqual(digest(left), digest(right));
}

/** Verify official workload resources against the complete injected PROD binding.
 * The /env response supplies resources, not an independent remote project-ID assertion. */
export async function verifyProductionWorkloadResources(): Promise<boolean> {
  const currentPhase = phase();
  const identityHash = identityFingerprint();
  const injected = getInjectedProjectResources();
  if (currentPhase !== 'PROD' || (state.identityHash !== undefined && identityHash !== state.identityHash) ||
    !injected?.databaseUrl || !injected.phoneConfiguration) return false;
  try {
    // Existing single-flight/cache performs the official OAuth exchange and /env request.
    const official = await getWorkloadProjectResources();
    if (official && state.stage === 'ready') state.operation = 'binding';
    return phase() === currentPhase && identityFingerprint() === identityHash && state.identityHash === identityHash &&
      state.phase === currentPhase && state.stage === 'ready' && state.expiresAt > Date.now() &&
      resourceBindingsMatch(injected, getInjectedProjectResources()) &&
      resourceBindingsMatch(injected, official) && resourceBindingsMatch(injected, state.resources);
  } catch {
    return false;
  }
}

/** Diagnostics expose only readiness flags and sanitized failure categories. */
export function workloadRuntimeStatus(): WorkloadRuntimeStatus {
  const environment = environmentPresence();
  const currentPhase = phase();
  const now = Date.now();
  const permitted = currentPhase !== null && (!state.phase || state.phase === currentPhase) &&
    REQUIRED_ENV.every((name) => environment[name]) &&
    (state.identityHash === undefined || identityFingerprint() === state.identityHash);
  if (state.stage === 'ready' && state.expiresAt <= now) {
    state.resources = undefined;
    state.expiresAt = 0;
    state.stage = 'idle';
    state.operation = 'idle';
    state.accessTokenVerified = false;
  }
  const resources = permitted && state.phase === currentPhase && state.expiresAt > now ? state.resources : undefined;
  return {
    environment,
    stage: permitted ? state.stage : 'blocked',
    httpStatus: permitted ? state.httpStatus : null,
    errorType: permitted ? state.errorType : 'ConfigurationError',
    operation: permitted ? state.operation ?? 'idle' : 'idle',
    accessTokenVerified: permitted && state.accessTokenVerified === true,
    failureReason: permitted ? state.failureReason ?? null : null,
    businessCode: permitted ? state.businessCode ?? null : null,
    endpoints: endpointFormats(),
    laneConfigured: Boolean(process.env.COZE_SERVER_ENV?.trim() && process.env.COZE_SERVER_ENV?.trim() !== 'NONE'),
    lane: laneStatus(),
    ...(permitted && state.responseDiagnostics ? { responseDiagnostics: { ...state.responseDiagnostics } } : {}),
    resources: { database: Boolean(resources?.databaseUrl), phone: Boolean(resources?.phoneConfiguration),
      projectApiToken: Boolean(resources?.projectApiToken) },
    productionConfigurationAccepted: productionConfigurationAccepted(),
    productionBindingVerified: currentPhase === 'PROD' && state.stage === 'ready' &&
      resourceBindingsMatch(getInjectedProjectResources(), resources),
  };
}

/** Explicit protected diagnostics only. This response never supplies project resources. */
export async function diagnoseWorkloadProjectEnvFailure(): Promise<void> {
  const identityHash = identityFingerprint();
  const allowed = (): boolean => phase() === 'PROD' && state.phase === 'PROD' &&
    state.identityHash === identityHash && identityFingerprint() === identityHash &&
    REQUIRED_ENV.every(name => Boolean(process.env[name]?.trim())) &&
    state.clientLane === (process.env.COZE_SERVER_ENV ?? 'NONE') &&
    state.stage === 'cooldown' && !state.pending && state.operation === 'project-env' &&
    state.httpStatus === 400 && state.accessTokenVerified === true;
  if (state.responseProbeAttempted || !state.client || !allowed() ||
    state.operation !== 'project-env' || state.httpStatus !== 400 || state.accessTokenVerified !== true) return;
  // No automatic HTTP retry or repeated sampling on subsequent status requests.
  state.responseProbeAttempted = true;
  const result = await diagnoseWorkloadEnvResponse({ client: state.client,
    endpoint: process.env.COZE_OUTBOUND_AUTH_ENDPOINT ?? '', lane: state.clientLane,
    contextStillMatches: allowed });
  if (allowed()) state.responseDiagnostics = result;
}

/** Resolve only allowlisted resources supplied by the official workload client. */
export async function getWorkloadProjectResources(): Promise<WorkloadProjectResources | null> {
  const currentPhase = phase();
  const presence = environmentPresence();
  if (!currentPhase || (state.phase && state.phase !== currentPhase) ||
    !REQUIRED_ENV.every((name) => presence[name]) ||
    (state.identityHash !== undefined && identityFingerprint() !== state.identityHash)) return null;
  if (state.identityHash === undefined) {
    // Config may synchronously load the platform .env before this first request.
    // Freeze once before any official authorization/client/cache operation.
    if (state.client || state.pending || state.phase || state.resources) return null;
    state.identityHash = identityFingerprint();
  }
  if (state.resources && state.expiresAt > Date.now()) return copyResources(state.resources);
  if (state.retryAt > Date.now()) return null;
  if (!state.pending) {
    state.phase = currentPhase;
    state.stage = 'loading';
    state.operation = 'construct';
    state.accessTokenVerified = false;
    state.failureReason = null;
    state.businessCode = null;
    state.pending = Promise.resolve().then(async () => {
      try {
        if (phase() !== currentPhase || identityFingerprint() !== state.identityHash)
          throw new Error('WORKLOAD_RUNTIME_CONTEXT_CHANGED');
        if (!state.client) {
          state.client = new Client({ timeoutMs: 10_000 });
          state.clientLane = process.env.COZE_SERVER_ENV ?? 'NONE';
        }
        state.operation = 'access-token';
        // Public SDK method, same Client/cache. Discard the token immediately;
        // project-env is not marked until this operation actually succeeds.
        await state.client.getAccessToken();
        state.accessTokenVerified = true;
        state.operation = 'project-env';
        const values = await state.client.getProjectEnvVars();
        state.operation = 'parse';
        if (phase() !== currentPhase || identityFingerprint() !== state.identityHash ||
          !REQUIRED_ENV.every((name) => Boolean(process.env[name]?.trim())))
          throw new Error('WORKLOAD_RUNTIME_CONTEXT_CHANGED');
        const resources: WorkloadProjectResources = {};
        const configuredDatabase = values.get(`PGDATABASE_URL_${currentPhase}`);
        resources.databaseUrl = databaseUrl(configuredDatabase);
        resources.phoneConfiguration = phoneConfiguration(values.get(`TIYU_SUPABASE_URL_${currentPhase}`),
          values.get(`TIYU_SUPABASE_ANON_KEY_${currentPhase}`));
        const projectApiToken = values.get('COZE_API_TOKEN')?.trim();
        if (projectApiToken && projectApiToken.length <= 8192 && !/[\u0000-\u0020\u007f]/.test(projectApiToken))
          resources.projectApiToken = projectApiToken;
        state.resources = resources;
        state.expiresAt = Date.now() + RESOURCE_CACHE_MS;
        state.retryAt = 0;
        state.stage = 'ready';
        state.httpStatus = null;
        state.errorType = null;
        state.failureReason = null;
        state.businessCode = null;
        return resources;
      } catch (error: unknown) {
        const details = failureDetails(error);
        state.resources = undefined;
        state.expiresAt = 0;
        state.retryAt = Date.now() + FAILURE_COOLDOWN_MS;
        state.stage = 'cooldown';
        state.httpStatus = details.httpStatus;
        state.errorType = details.errorType;
        state.failureReason = details.failureReason;
        state.businessCode = details.businessCode;
        return null;
      } finally {
        state.pending = undefined;
      }
    });
  }
  const resources = await state.pending;
  if (phase() !== currentPhase || identityFingerprint() !== state.identityHash) return null;
  return resources ? copyResources(resources) : null;
}
