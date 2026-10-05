export type AiImagePayload = {mimeType:'image/jpeg'|'image/png';data:string};
export const AI_IMAGE_LIMIT: number;
export function modelSupportsImages(modelId: string,inputTypes?: unknown): boolean;
export function validateAiImage(value: unknown): AiImagePayload;
export function aiImageDigest(image: AiImagePayload): string;
export function aiImageUrl(image: AiImagePayload): string;
