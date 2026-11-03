export const COZE_ASSISTANT_PROTOCOL: 'coze_json_v1';
export type CozeAssistantBinding = { execution: 'coze'; provider: string; modelId: string };
export type ValidatedAssistantRequest = {
  requestId: string; timeoutSeconds: number; protocolVersion: number; mode: string;
  image: unknown; visionEnabled: boolean; tools: unknown[];
};
export type PreparedCozeAssistant = {
  request: ValidatedAssistantRequest;
  body: Record<string, unknown>;
  configuration: Record<string, unknown>;
};
export function prepareCozeAssistant(config: CozeAssistantBinding, input: unknown): PreparedCozeAssistant;
export function cozeAssistantJsonResult(content: string, request: ValidatedAssistantRequest, reasoning?: string): Record<string, unknown>;
