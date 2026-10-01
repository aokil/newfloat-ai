import { previewRequest } from '@/lib/tiyu-preview.server';

// The custom HTTP server dispatches business APIs directly to Fastify.
// No user response is prerendered.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function dispatch(request: Request): Promise<Response> {
  return await previewRequest(request) ?? Response.json({ error: {
    code: 'NOT_FOUND', message: '未找到', retryable: false,
  } }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export const GET = dispatch;
export const HEAD = dispatch;
export const POST = dispatch;
export const PUT = dispatch;
export const PATCH = dispatch;
export const DELETE = dispatch;
export const OPTIONS = dispatch;
