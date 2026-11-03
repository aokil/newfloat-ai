import {assistantCompletion} from '@/lib/coze-assistant.server';
import {denyModelCompletion} from '@/lib/coze-llm.server';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export const POST=assistantCompletion;
export const GET=denyModelCompletion;
export const HEAD=denyModelCompletion;
export const PUT=denyModelCompletion;
export const PATCH=denyModelCompletion;
export const DELETE=denyModelCompletion;
export const OPTIONS=denyModelCompletion;
