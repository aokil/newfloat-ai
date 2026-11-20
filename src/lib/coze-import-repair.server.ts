import {HeaderUtils} from 'coze-coding-dev-sdk';
import {cozeAssistantRuntime} from './coze-llm.server';
import {cozeGatewayImportRepair} from '../../question-bank/server/src/import-repair-transport.js';

/** Local native bridge only. Authentication, durable idempotency and anomaly budgets belong to Fastify. */
export async function cozeProjectImportRepair(modelId:string,input:unknown,execution:{
  requestId:string;signal:AbortSignal;onSubmitted:()=>void;
}):Promise<Record<string,unknown>>{
  const runtime=await cozeAssistantRuntime(modelId,Date.now()+90000,execution.signal);
  const headers=runtime.config.getHeaders(HeaderUtils.extractForwardHeaders(new Headers()));
  return cozeGatewayImportRepair({baseUrl:runtime.config.modelBaseUrl,key:runtime.config.apiKey,headers},modelId,input,execution);
}
