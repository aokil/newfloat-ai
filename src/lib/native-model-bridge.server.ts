import { BRIDGE_ERRORS } from '../../question-bank/server/src/coze-model-transport.js';
import { ApiError } from '../../question-bank/server/src/security.js';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateAiImage } from '../../question-bank/server/src/ai-image.js';
import type { AiImagePayload } from '../../question-bank/server/src/ai-image.js';
import { cozeModelFailureCode, cozeProjectModelCompletion, cozeProjectModelMetadata,
  cozeProjectModelsReady, BridgeError } from './coze-llm.server';
import type { CozeModelExecutionContext, CozeModelMetadata, CozeSearchResult, CozeTestResult, CozeExtractionResult } from './coze-llm.server';
import {cozeProjectAssistantCompletion} from './coze-assistant.server';
import {cozeProjectMediaOperation} from './coze-media.server';
import type {CozeAssistantEmit,CozeAssistantConfigure} from '../../question-bank/server/src/coze-assistant-transport.js';

type ModelConfiguration = { modelId: string; timeoutMs: number; maxOutputTokens: number };
type CallContext = CozeModelExecutionContext & { requestId: string; image?: AiImagePayload };
export type NativeModelBridge = {
  readonly ready: boolean;
  metadata(): Promise<CozeModelMetadata>;
  test(model: unknown, context: unknown): Promise<CozeTestResult>;
  search(model: unknown, question: unknown, context: unknown): Promise<CozeSearchResult>;
  extract(model: unknown, image: unknown, context: unknown): Promise<CozeExtractionResult>;
  assistant(model: unknown, request: unknown, signal: AbortSignal, onText?: CozeAssistantEmit,
    onReasoning?: CozeAssistantEmit, onConfiguration?: CozeAssistantConfigure): Promise<Record<string,unknown>>;
  media(operation: unknown, input: unknown, signal: AbortSignal): Promise<Record<string,unknown>>;
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

type RuntimeApiErrorConstructor = new (status: number, code: string, message: string, details?: unknown) => Error;
let runtimeApiErrorClass: Promise<RuntimeApiErrorConstructor> | undefined;

/** The Fastify backend is unbundled, so its ApiError class differs from the bundled copy.
 * Rehydrate only errors already classified as public by this bridge; raw SDK errors stay private. */
async function nativePublicFailure(error: unknown): Promise<unknown> {
  const failure = error instanceof ApiError && record(error) && typeof error.statusCode === 'number' && typeof error.code === 'string'
    ? {status: error.statusCode, code: error.code, message: error.message, details: error.details}
    : error instanceof BridgeError
      ? {status: error.status, code: error.code, message: error.publicMessage, details: undefined}
      : null;
  if (!failure || !Number.isInteger(failure.status) || failure.status < 400 || failure.status > 599 ||
      !/^[A-Z0-9_]{1,80}$/.test(failure.code) || typeof failure.message !== 'string') return error;
  try {
    runtimeApiErrorClass ??= (async () => {
      // Exactly the same fixed source path imported by createCozeApp, never a request-provided path.
      const loaded: unknown = await import(/* webpackIgnore: true */ pathToFileURL(path.resolve(process.cwd(), 'question-bank/server/src/security.js')).href);
      if (!record(loaded) || typeof loaded.ApiError !== 'function') throw new Error('NATIVE_ERROR_CLASS_UNAVAILABLE');
      return loaded.ApiError as RuntimeApiErrorConstructor;
    })();
    const RuntimeApiError = await runtimeApiErrorClass;
    const converted = new RuntimeApiError(failure.status, failure.code, failure.message, failure.details);
    if (error instanceof Error && typeof error.stack === 'string') {
      const prefix = error.message ? `${error.name}: ${error.message}` : error.name;
      if (error.stack.startsWith(prefix)) converted.stack = `${converted.name}: ${converted.message}${error.stack.slice(prefix.length)}`;
    }
    return converted;
  } catch {
    runtimeApiErrorClass = undefined;
    return error;
  }
}

/** Direct SDK adapter for Fastify in this Coze process; no localhost server, HMAC or extra billing. */
export function nativeModelBridge(): NativeModelBridge {
  async function execute(mode: 'search' | 'test' | 'extract', model: unknown, question: unknown, context: unknown) {
    if(mode==='extract'&&(!record(model)||model.provider!=='doubao'||model.catalogKey!=='doubao-mini'))throw new Error('INVALID_PROVIDER_RESPONSE');
    const config = configuration(model);
    const call = callContext(context);
    if (mode === 'search' && (typeof question !== 'string' || !question.trim() || question.length > 16_000)) {
      throw new Error('INVALID_ANSWER');
    }
    try {
      return (await cozeProjectModelCompletion({ requestId: call.requestId, mode, modelId: config.modelId,
        ...(mode === 'search' ? { question } : {}), ...(mode!=='test'&&call.image?{image:call.image}:{}), timeoutMs: Math.min(config.timeoutMs, 25_000),
        maxOutputTokens: config.maxOutputTokens }, call)).result;
    } catch (error: unknown) {
      throw safeFailure(error);
    }
  }
  return Object.freeze({
    get ready() { return cozeProjectModelsReady(); },
    async media(operation: unknown, input: unknown, signal: AbortSignal) {
      try { return await cozeProjectMediaOperation(operation, input, signal); }
      catch (error: unknown) { throw await nativePublicFailure(error); }
    },
    async assistant(model: unknown, request: unknown, signal: AbortSignal, onText: CozeAssistantEmit=async()=>{},
      onReasoning: CozeAssistantEmit=async()=>{},onConfiguration: CozeAssistantConfigure=async()=>{}) {
      try {
        if(!record(model)||model.execution!=='coze'||typeof model.provider!=='string'||typeof model.modelId!=='string')
          throw new ApiError(422,'COZE_ASSISTANT_CONFIGURATION_INVALID','Coze对话模型绑定格式无效');
        const result=await cozeProjectAssistantCompletion({execution:'coze',provider:model.provider,modelId:model.modelId},request,
          {signal,onReasoning,onConfiguration});
        if(signal.aborted)throw new ApiError(499,'ASSISTANT_REQUEST_CANCELLED','对话已取消，未返回工具决定');
        const choices=result.choices;
        if(Array.isArray(choices)&&record(choices[0])&&record(choices[0].message)&&typeof choices[0].message.content==='string'&&choices[0].message.content)
          await onText(choices[0].message.content);
        return result;
      } catch (error: unknown) { throw await nativePublicFailure(error); }
    },
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
    async extract(model: unknown,image: unknown,context: unknown) {
      if(!record(context))throw new Error('INVALID_PROVIDER_RESPONSE');
      const result=await execute('extract',model,undefined,{...context,image});
      if(!('rawText' in result))throw new Error('OCR_RESPONSE_INVALID');
      return result;
    },
  });
}
