import type { Client } from '@coze/workload-identity';

const DIAGNOSTIC_BUDGET_MS = 2_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const MAX_ERROR_STRING_LENGTH = 2_048;
const MAX_JSON_DEPTH = 3;
// Matched to the installed @coze/workload-identity 0.1.0 dist/client implementation.
const SDK_USER_AGENT = 'coze-workload-identity/0.1.0';

type ResponseBodyKind = 'json' | 'text' | 'empty' | 'invalid' | 'truncated' | 'unavailable';
type FailureReason = 'missing-project' | 'missing-environment' | 'permission' |
  'unsupported-runtime' | 'configuration-not-found' | 'invalid-parameter' |
  'project-context-invalid' | 'other';

export type WorkloadEnvResponseDiagnostics = {
  httpStatus: number | null;
  businessCode: number | null;
  bodyKind: ResponseBodyKind;
  messagePresent: boolean;
  failureReason: FailureReason;
};

type DiagnosticOptions = {
  client: Client;
  endpoint: string;
  lane: string | undefined;
  /** The caller must verify the fixed project 7689833705046130729, PROD phase,
   * all five official workload environment entries and the frozen identity,
   * including the Client's endpoint/lane snapshot. No environment is read here. */
  contextStillMatches: () => boolean;
};

const CODE_FIELDS = ['code', 'Code', 'error_code', 'errorCode', 'ErrorCode',
  'status_code', 'statusCode', 'StatusCode'] as const;
const MESSAGE_FIELDS = ['msg', 'Msg', 'message', 'Message', 'error_msg', 'errorMsg',
  'ErrorMsg', 'error_message', 'errorMessage', 'ErrorMessage', 'error_description',
  'status_message', 'statusMessage', 'StatusMessage', 'error', 'Error'] as const;
// Inspect only standard error envelopes, never data, secrets, or arbitrary keys.
const ERROR_ENVELOPES = ['error', 'Error', 'BaseResp', 'baseResp', 'base_resp',
  'response', 'Response'] as const;

function emptyResult(bodyKind: ResponseBodyKind, httpStatus: number | null = null):
  WorkloadEnvResponseDiagnostics {
  return { httpStatus, businessCode: null, bodyKind, messagePresent: false, failureReason: 'other' };
}

function matchesContext(check: () => boolean): boolean {
  try { return check() === true; } catch { return false; }
}

function safeEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > 8_192 || /[\u0000-\u0020\u007f]/.test(endpoint) ||
    endpoint.includes('?') || endpoint.includes('#')) return false;
  try {
    const url = new URL(endpoint);
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname) &&
      !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function own(value: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function numericCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,16}$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/** Returns only a fixed category. The bounded upstream string is never retained. */
function classifyMessage(message: string): FailureReason {
  if (!message || message.length > MAX_ERROR_STRING_LENGTH) return 'other';
  const value = message.toLowerCase();
  const missing = /\b(?:missing|required|not\s+provided|not\s+found|empty)\b|缺少|缺失|未提供|不存在|为空/.test(value);
  if ((/\b(?:project_id|project[ _-]id)\b|项目(?:id|标识)/.test(value) && missing) ||
    /\bmissing\s+project\b(?!\s+(?:env|environment))|\bproject\s+(?:is\s+)?(?:missing|required|not\s+found)\b|缺少项目|项目缺失/.test(value))
    return 'missing-project';
  if (/\b(?:environment|project_env|projectenv|project_environment|env)\b|环境/.test(value) && missing)
    return 'missing-environment';
  if (/\b(?:permission|forbidden|unauthorized|insufficient_scope|access\s+denied|not\s+allowed)\b|无权限|没有权限|权限不足|禁止访问|未授权/.test(value))
    return 'permission';
  if (/\b(?:runtime|platform)\b|运行时|运行环境|平台/.test(value) &&
    /\b(?:unsupported|not\s+supported)\b|不支持/.test(value)) return 'unsupported-runtime';
  if (/\b(?:configuration|config|secret|secrets)\b|配置|密钥/.test(value) &&
    /\b(?:not\s+found|missing|unavailable|does\s+not\s+exist)\b|未找到|不存在|缺失|未配置/.test(value))
    return 'configuration-not-found';
  if (/\b(?:project(?:[ _-](?:id|context|identity|binding))?)\b|项目/.test(value) &&
    /\b(?:invalid|malformed|mismatch|mismatched|inconsistent)\b|\b(?:does\s+not|doesn't)\s+match\b|无效|不合法|不一致|不匹配/.test(value))
    return 'project-context-invalid';
  if (/\b(?:invalid|malformed|bad)\s+(?:request|parameter|parameters|param|argument|arguments)\b|\b(?:parameter|parameters|param|argument|arguments)\b.*\b(?:invalid|malformed|required)\b|参数错误|参数无效|参数不合法|缺少参数/.test(value))
    return 'invalid-parameter';
  return 'other';
}

/** Bound parser nesting before JSON.parse; braces inside quoted strings do not count. */
function shallowJson(text: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{' || character === '[') {
      depth += 1;
      if (depth > MAX_JSON_DEPTH) return false;
    } else if (character === '}' || character === ']') depth -= 1;
  }
  return true;
}

function inspectErrorFields(value: unknown, diagnostics: WorkloadEnvResponseDiagnostics,
  depth: number = 1): void {
  if (!record(value) || depth > MAX_JSON_DEPTH) return;
  for (const field of CODE_FIELDS) {
    const candidate = numericCode(own(value, field));
    if (diagnostics.businessCode === null && candidate !== null) diagnostics.businessCode = candidate;
  }
  for (const field of MESSAGE_FIELDS) {
    const candidate = own(value, field);
    if (typeof candidate !== 'string') continue;
    diagnostics.messagePresent = true;
    const reason = classifyMessage(candidate);
    if (diagnostics.failureReason === 'other' && reason !== 'other') diagnostics.failureReason = reason;
  }
  if (depth < MAX_JSON_DEPTH) {
    for (const field of ERROR_ENVELOPES) inspectErrorFields(own(value, field), diagnostics, depth + 1);
  }
}

function classifyBody(bytes: Uint8Array, httpStatus: number | null): WorkloadEnvResponseDiagnostics {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim(); }
  catch { return emptyResult('invalid', httpStatus); }
  if (!text) return emptyResult('empty', httpStatus);
  const structured = text.startsWith('{') || text.startsWith('[');
  if (structured && !shallowJson(text)) return emptyResult('invalid', httpStatus);
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch {
    if (structured || text.startsWith('"')) return emptyResult('invalid', httpStatus);
    return { ...emptyResult('text', httpStatus), failureReason: classifyMessage(text) };
  }
  const diagnostics = emptyResult('json', httpStatus);
  inspectErrorFields(value, diagnostics);
  return diagnostics;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

async function readResponse(response: Response, active: () => boolean, signal: AbortSignal):
  Promise<WorkloadEnvResponseDiagnostics> {
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ?
    response.status : null;
  if (!active()) {
    cancelBody(response.body);
    return emptyResult('unavailable');
  }
  if (!response.body) return emptyResult('empty', status);
  const reader = response.body.getReader();
  const cancelRead = (): void => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', cancelRead, { once: true });
  if (signal.aborted) cancelRead();
  const bytes = new Uint8Array(MAX_RESPONSE_BYTES);
  let count = 0;
  let finished = false;
  try {
    while (active()) {
      const chunk = await reader.read();
      if (!active()) return emptyResult('unavailable');
      if (chunk.done) {
        finished = true;
        return classifyBody(bytes.subarray(0, count), status);
      }
      if (chunk.value.byteLength > MAX_RESPONSE_BYTES - count) return emptyResult('truncated', status);
      bytes.set(chunk.value, count);
      count += chunk.value.byteLength;
    }
    return emptyResult('unavailable');
  } catch { return emptyResult('unavailable', status); }
  finally {
    signal.removeEventListener('abort', cancelRead);
    if (!finished) cancelRead();
    reader.releaseLock();
  }
}

/** A single read-only /env sample for the caller's already gated SDK HTTP 400.
 * This returns no resources and cannot verify or authorize a production binding.
 * The public SDK token method cannot be canceled; a late token never starts /env. */
export async function diagnoseWorkloadEnvResponse(options: DiagnosticOptions):
  Promise<WorkloadEnvResponseDiagnostics> {
  const deadline = performance.now() + DIAGNOSTIC_BUDGET_MS;
  const { client, endpoint, lane, contextStillMatches } = options;
  if (!safeEndpoint(endpoint) || !matchesContext(contextStillMatches) ||
    (lane !== undefined && (lane.length > MAX_ERROR_STRING_LENGTH || /[\u0000-\u001f\u007f]/.test(lane))))
    return emptyResult('unavailable');
  const controller = new AbortController();
  let closed = false;
  let httpStatus: number | null = null;
  const active = (): boolean => !closed && !controller.signal.aborted && performance.now() < deadline &&
    matchesContext(contextStillMatches);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<WorkloadEnvResponseDiagnostics>((resolve) => {
    timer = setTimeout(() => {
      closed = true;
      controller.abort();
      resolve(emptyResult('unavailable', httpStatus));
    }, Math.max(0, deadline - performance.now()));
  });
  const sample = async (): Promise<WorkloadEnvResponseDiagnostics> => {
    try {
      if (!active()) return emptyResult('unavailable');
      const token = await client.getAccessToken();
      // This guard is reached even if getAccessToken resolves after the outer race.
      if (!active() || !token) return emptyResult('unavailable');
      const headers: Record<string, string> = {
        'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': SDK_USER_AGENT,
      };
      if (lane && lane !== 'NONE') {
        headers['x-tt-env'] = lane;
        if (lane.startsWith('ppe_')) headers['x-use-ppe'] = '1';
      }
      if (!active()) return emptyResult('unavailable');
      // Preserve the SDK's literal suffix behavior rather than normalizing the path.
      const response = await fetch(`${endpoint}/env`, {
        method: 'GET', headers, signal: controller.signal, redirect: 'error', cache: 'no-store',
      });
      if (!active()) {
        cancelBody(response.body);
        return emptyResult('unavailable');
      }
      if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599)
        httpStatus = response.status;
      // A retry may recover. Its successful body contains resources, so discard it.
      if (response.ok) {
        cancelBody(response.body);
        return emptyResult('unavailable', httpStatus);
      }
      const diagnostics = await readResponse(response, active, controller.signal);
      return active() ? diagnostics : emptyResult('unavailable', httpStatus);
    } catch { return emptyResult('unavailable', httpStatus); }
  };
  try {
    const diagnostics = await Promise.race([sample(), timeout]);
    return matchesContext(contextStillMatches) ? diagnostics : emptyResult('unavailable');
  } finally {
    closed = true;
    controller.abort();
    if (timer !== undefined) clearTimeout(timer);
  }
}
