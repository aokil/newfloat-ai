import type {CozeAssistantBinding} from './assistant-json-planner.js';
export const COZE_ASSISTANT_PATH: '/internal/assistant-completion';
export type CozeAssistantEmit = (text: string) => Promise<void>;
export type CozeAssistantConfigure = (configuration: Record<string, unknown>) => Promise<void>;
export type CozeAssistantUsage = (usage: unknown, metadata?: {created?: number}) => Promise<void>;
export type CozeGatewayContext = {baseUrl: string; key: string; headers: Record<string, string>};
export function cozeGatewayAssistant(context: CozeGatewayContext, model: CozeAssistantBinding, input: unknown, signal: AbortSignal,
  callbacks?: {onReasoning?: CozeAssistantEmit; onConfiguration?: CozeAssistantConfigure; onUsage?: CozeAssistantUsage}): Promise<Record<string, unknown>>;
export function remoteCozeAssistant(bridge: {origin: string; environment: string; key: string} | null):
  (model: CozeAssistantBinding, input: unknown, signal: AbortSignal, onText?: CozeAssistantEmit,
    onReasoning?: CozeAssistantEmit, onConfiguration?: CozeAssistantConfigure, onUsage?: CozeAssistantUsage) => Promise<Record<string, unknown>>;
