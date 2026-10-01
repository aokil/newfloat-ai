import { createHash, timingSafeEqual } from 'node:crypto';
import { Client } from '@coze/workload-identity';

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

type Phase = 'DEV' | 'PROD';
type Stage = 'idle' | 'loading' | 'ready' | 'cooldown' | 'blocked';
type ErrorType = 'ConfigurationError' | 'TokenRetrievalError' | 'TokenExchangeError' |
  'WorkloadIdentityError' | 'NetworkError' | 'APIError' | 'Error';
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
  resources: { database: boolean; phone: boolean; projectApiToken: boolean };
  productionBindingVerified: boolean;
};
type SharedState = {
  identityHash?: string;
  phase?: Phase;
  client?: Client;
  resources?: WorkloadProjectResources;
  expiresAt: number;
  pending?: Promise<WorkloadProjectResources | null>;
  retryAt: number;
  stage: Stage;
  httpStatus: number | null;
  errorType: ErrorType | null;
};
const STATE_KEY = Symbol.for('float-ai/coze-workload-resources/v1');
const sharedGlobal = globalThis as typeof globalThis & { [STATE_KEY]?: SharedState };
const state = sharedGlobal[STATE_KEY] ??= {
  expiresAt: 0, retryAt: 0, stage: 'idle', httpStatus: null, errorType: null,
};

// The SDK token cache is process-wide. A changed identity requires a fresh process;
// constructing another Client cannot safely switch the cached workload identity.
function identityFingerprint(): string {
  const identityEnvironment = [...REQUIRED_ENV, 'COZE_PROJECT_ID', 'COZE_PROJECT_ENV',
    'COZE_API_TOKEN', 'COZE_WORKLOAD_IDENTITY_API_KEY'];
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

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failureDetails(error: unknown): Pick<WorkloadRuntimeStatus, 'httpStatus' | 'errorType'> {
  const result: Pick<WorkloadRuntimeStatus, 'httpStatus' | 'errorType'> = { httpStatus: null, errorType: null };
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
  if (result.httpStatus === null && typeof error.message === 'string') {
    const matched = error.message.match(/\b(?:HTTP |request failed with status )([1-5]\d{2})\b/);
    if (matched) result.httpStatus = Number(matched[1]);
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
  }
  const resources = permitted && state.phase === currentPhase && state.expiresAt > now ? state.resources : undefined;
  return {
    environment,
    stage: permitted ? state.stage : 'blocked',
    httpStatus: permitted ? state.httpStatus : null,
    errorType: permitted ? state.errorType : 'ConfigurationError',
    resources: { database: Boolean(resources?.databaseUrl), phone: Boolean(resources?.phoneConfiguration),
      projectApiToken: Boolean(resources?.projectApiToken) },
    productionBindingVerified: currentPhase === 'PROD' && state.stage === 'ready' &&
      resourceBindingsMatch(getInjectedProjectResources(), resources),
  };
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
    state.pending = Promise.resolve().then(async () => {
      try {
        if (phase() !== currentPhase || identityFingerprint() !== state.identityHash)
          throw new Error('WORKLOAD_RUNTIME_CONTEXT_CHANGED');
        state.client ??= new Client({ timeoutMs: 10_000 });
        const values = await state.client.getProjectEnvVars();
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
        return resources;
      } catch (error: unknown) {
        const details = failureDetails(error);
        state.resources = undefined;
        state.expiresAt = 0;
        state.retryAt = Date.now() + FAILURE_COOLDOWN_MS;
        state.stage = 'cooldown';
        state.httpStatus = details.httpStatus;
        state.errorType = details.errorType;
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
