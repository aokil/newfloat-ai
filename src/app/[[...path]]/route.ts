import { proxyRequest } from '@/lib/tiyu-gateway.server';
import { previewRequest } from '@/lib/tiyu-preview.server';

// DEV previews use the committed website files; PROD and APIs use the backend.
// No user response is prerendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function dispatch(request: Request): Promise<Response> {
  return await previewRequest(request) ?? proxyRequest(request);
}

export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
