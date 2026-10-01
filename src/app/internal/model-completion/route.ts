import { denyModelCompletion, modelCompletion } from '@/lib/coze-llm.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = modelCompletion;
export const POST = modelCompletion;
export const HEAD = denyModelCompletion;
export const PUT = denyModelCompletion;
export const PATCH = denyModelCompletion;
export const DELETE = denyModelCompletion;
export const OPTIONS = denyModelCompletion;
