import { readFile } from 'node:fs/promises';
import path from 'node:path';

type PreviewEnvironment = Record<string, string | undefined>;
type PreviewAsset = { file: string; contentType: string };

// These repository-owned files are the complete preview surface. A request path
// is only a lookup key; it never becomes a filesystem path or a directory glob.
const ASSETS: ReadonlyMap<string, PreviewAsset> = new Map([
  ['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', contentType: 'text/css; charset=utf-8' }],
  ['/brandmark.svg', { file: 'brandmark.svg', contentType: 'image/svg+xml' }],
  ['/workspace.js', { file: 'workspace.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/workspace.css', { file: 'workspace.css', contentType: 'text/css; charset=utf-8' }],
  ['/ui-assets.js', { file: 'ui-assets.js', contentType: 'text/javascript; charset=utf-8' }],
  ['/assets/avatars/pinterest-01.jpg', { file: 'assets/avatars/pinterest-01.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/pinterest-02.jpg', { file: 'assets/avatars/pinterest-02.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/pinterest-03.jpg', { file: 'assets/avatars/pinterest-03.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/pinterest-04.jpg', { file: 'assets/avatars/pinterest-04.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/pinterest-05.jpg', { file: 'assets/avatars/pinterest-05.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/pinterest-06.jpg', { file: 'assets/avatars/pinterest-06.jpg', contentType: 'image/jpeg' }],
  ['/assets/avatars/sources.json', { file: 'assets/avatars/sources.json', contentType: 'application/json; charset=utf-8' }],
  ['/assets/model-icons-license.txt', { file: 'assets/model-icons-license.txt', contentType: 'text/plain; charset=utf-8' }],
]);

// Coze embeds DEV previews and injects its editor/console/history bridge scripts.
// Allow that fixed HTTPS CDN only in DEV; PROD policy is owned by the gateway.
const PREVIEW_CSP = "default-src 'self'; script-src 'self' https://lf-cdn.coze.cn; style-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

/** Serve the same committed website in DEV and PROD; APIs run in Coze. */
export function createPreviewFileServer(
  env: PreviewEnvironment = process.env,
  publicRoot: string = path.resolve(process.cwd(), 'question-bank/server/public'),
) {
  return async function preview(request: Request): Promise<Response | null> {
    if (request.method !== 'GET' && request.method !== 'HEAD') return null;

    const asset = ASSETS.get(new URL(request.url).pathname);
    if (!asset) return null;

    const headers = new Headers({
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': env.COZE_PROJECT_ENV === 'PROD'
        ? "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        : PREVIEW_CSP,
    });
    try {
      const data = await readFile(path.join(publicRoot, asset.file));
      headers.set('Content-Type', asset.contentType);
      headers.set('Content-Length', String(data.byteLength));
      return new Response(request.method === 'HEAD' ? null : new Uint8Array(data), { headers });
    } catch {
      // Do not expose the disk location or exception. Missing preview files are
      // a real unavailable state, not a fake successful or sample-filled page.
      const body = JSON.stringify({ error: {
        code: 'PREVIEW_FILE_UNAVAILABLE', message: '预览文件暂不可用，请重新同步项目后重试。', retryable: true,
      } });
      headers.set('Content-Type', 'application/json; charset=utf-8');
      headers.set('Content-Length', String(Buffer.byteLength(body)));
      return new Response(request.method === 'HEAD' ? null : body, { status: 503, headers });
    }
  };
}

export const previewRequest = createPreviewFileServer();
