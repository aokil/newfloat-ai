import { BRIDGE_ERRORS } from '../../question-bank/server/src/coze-model-transport.js';
import { validateAiImage } from '../../question-bank/server/src/ai-image.js';
import type { AiImagePayload } from '../../question-bank/server/src/ai-image.js';
import { cozeModelFailureCode, cozeProjectModelCompletion, cozeProjectModelMetadata,
  cozeProjectModelsReady } from './coze-llm.server';
import type { CozeModelExecutionContext, CozeModelMetadata, CozeSearchResult, CozeTestResult } from './coze-llm.server';

type ModelConfiguration = { modelId: string; timeoutMs: number; maxOutputTokens: number };
type CallContext = CozeModelExecutionContext & { requestId: string; image?: AiImagePayload };
export type NativeModelBridge = {
  readonly ready: boolean;
  metadata(): Promise<CozeModelMetadata>;
  test(model: unknown, context: unknown): Promise<CozeTestResult>;
  search(model: unknown, question: unknown, context: unknown): Promise<CozeSearchResult>;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuration(model: unknown): ModelConfiguration {
  // Family-to-price binding remains owned by the account server's admin routes.
  // This adapter executes saved Coze configurations, never user-selected messages/endpoints.
  if (!record(model) || model.execution !== 'coze' || typeof model.catalogKey !== 'string' || !model.catalogKey ||
    typeof model.modelId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(model.modelId) ||
    typeof model.timeoutMs !== 'number' || !Number.isSafeInteger(model.timeoutMs) || model.timeoutMs < 3_000 || model.timeoutMs > 30_000 ||
    typeof model.maxOutputTokens !== 'number' || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens < 1 || model.maxOutputTokens > 8_192) {
    throw new Error('INVALID_PROVIDER_RESPONSE');
  }
  return { modelId: model.modelId, timeoutMs: model.timeoutMs, maxOutputTokens: model.maxOutputTokens };
}

function callContext(value: unknown): CallContext {
  if (!record(value) || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.requestId)) {
    throw new Error('INVALID_PROVIDER_RESPONSE');
  }
  const context: CallContext = { requestId: value.requestId };
  if(value.image!==undefined)context.image=validateAiImage(value.image);
  if (value.headers instanceof Headers) context.headers = value.headers;
  else if (value.headers !== undefined) {
    if (!record(value.headers) || !Object.values(value.headers).every(entry => typeof entry === 'string')) {
      throw new Error('INVALID_PROVIDER_RESPONSE');
    }
    context.headers = value.headers as Record<string, string>;
  }
  if (value.signal !== undefined) {
    if (!(value.signal instanceof AbortSignal)) throw new Error('INVALID_PROVIDER_RESPONSE');
    context.signal = value.signal;
  }
  return context;
}

function safeFailure(error: unknown): Error {
  const code = cozeModelFailureCode(error);
  const mapping: Readonly<Record<string, string>> = BRIDGE_ERRORS;
  return new Error(Object.hasOwn(mapping, code) ? mapping[code] :
    code === 'PROVIDER_RESPONSE_TOO_LARGE' ? 'PROVIDER_RESPONSE_TOO_LARGE' : 'PROVIDER_FAILED');
}

/** Direct SDK adapter for Fastify in this Coze process; no localhost server, HMAC or extra billing. */
export function nativeModelBridge(): NativeModelBridge {
  async function execute(mode: 'search' | 'test', model: unknown, question: unknown, context: unknown) {
    const config = configuration(model);
    const call = callContext(context);
    if (mode === 'search' && (typeof question !== 'string' || !question.trim() || question.length > 16_000)) {
      throw new Error('INVALID_ANSWER');
    }
    try {
      return (await cozeProjectModelCompletion({ requestId: call.requestId, mode, modelId: config.modelId,
        ...(mode === 'search' ? { question, ...(call.image ? {image:call.image} : {}) } : {}), timeoutMs: Math.min(config.timeoutMs, 25_000),
        maxOutputTokens: config.maxOutputTokens }, call)).result;
    } catch (error: unknown) {
      throw safeFailure(error);
    }
  }
  return Object.freeze({
    get ready() { return cozeProjectModelsReady(); },
    async metadata() {
      try {
        return await cozeProjectModelMetadata();
      } catch (error: unknown) {
        throw safeFailure(error);
      }
    },
    async test(model: unknown, context: unknown) {
      const result = await execute('test', model, undefined, context);
      if (!('status' in result) || result.status !== 'passed') throw new Error('INVALID_TEST_RESULT');
      return result;
    },
    async search(model: unknown, question: unknown, context: unknown) {
      const result = await execute('search', model, question, context);
      if (!('answer' in result)) throw new Error('INVALID_ANSWER');
      return result;
    },
  });
}
