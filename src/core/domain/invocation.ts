import type { ExecutionResult, SideEffectRecord } from "./execution.ts";

export type InvocationRoute = "host_agent" | "host_capability" | "local_cli";

export interface InvocationReceipt {
  id: string;
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  route: InvocationRoute;
  routeReason: string;
  capabilityRefs: string[];
  targetRef?: string;
  idempotencyKey?: string;
  approvalRef?: string;
  sideEffects: SideEffectRecord[];
  result: ExecutionResult["state"];
  startedAt: string;
  endedAt: string;
  createdAt: string;
}
