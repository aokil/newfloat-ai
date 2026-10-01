import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureDatabaseEnvironment, ensureSupabaseEnvironment } from 'coze-coding-dev-sdk';
import type { SupabaseEnvironment } from 'coze-coding-dev-sdk';
import { nativeModelBridge } from './native-model-bridge.server';

const PROJECT_ID = '7689833705046130729';
let backend: Promise<FastifyInstance> | undefined;
let retryAt = 0;
type NativeFactory = (options: { databaseUrl: string; phoneConfiguration?: SupabaseEnvironment;
  cozeBridge: ReturnType<typeof nativeModelBridge> }) => Promise<FastifyInstance>;

/** One shared backend per process, using only this project's DEV or PROD DB. */
export function getNativeBackend(): Promise<FastifyInstance> {
  if (backend) return backend;
  if (Date.now() < retryAt) return Promise.reject(new Error('COZE_BACKEND_UNAVAILABLE'));
  backend = (async () => {
    if (process.env.COZE_PROJECT_ID !== PROJECT_ID || !['DEV', 'PROD'].includes(process.env.COZE_PROJECT_ENV || ''))
      throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    const bridge = nativeModelBridge();
    // Normalize the SDK-supported platform token before database/Auth SDK setup.
    if (!bridge.ready) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    const database = await ensureDatabaseEnvironment();
    if (database.context.projectId !== PROJECT_ID) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    // Authentication may be temporarily unavailable; the website and database
    // remain usable, while SMS APIs return their genuine unavailable state.
    const phone = await ensureSupabaseEnvironment().catch(() => undefined);
    if (phone && phone.context.projectId !== PROJECT_ID) throw new Error('COZE_PROJECT_IDENTITY_UNAVAILABLE');
    // Keep the existing ESM backend unbundled: parser workers and public files
    // resolve their own import.meta.url in both preview and production.
    const loaded: unknown = await import(/* webpackIgnore: true */ pathToFileURL(path.resolve(process.cwd(), 'question-bank/server/src/coze-runtime.js')).href);
    if (!loaded || typeof loaded !== 'object' || !('createCozeApp' in loaded) || typeof loaded.createCozeApp !== 'function')
      throw new Error('COZE_BACKEND_MODULE_UNAVAILABLE');
    const createCozeApp = loaded.createCozeApp as NativeFactory;
    return await createCozeApp({ databaseUrl: database.databaseUrl,
      phoneConfiguration: phone, cozeBridge: bridge });
  })().catch(() => {
    backend = undefined;
    retryAt = Date.now() + 10_000;
    // SDK/database errors may contain connection credentials. Never serialize.
    throw new Error('COZE_BACKEND_UNAVAILABLE');
  });
  return backend;
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
  if (backend) await (await backend).close();
}
