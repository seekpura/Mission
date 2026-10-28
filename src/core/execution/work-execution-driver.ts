import type { Artifact } from "../domain/artifact.ts";
import type { ContextPacket } from "../domain/context.ts";
import type { ExecutionResult, ExecutionRuntimeBinding } from "../domain/execution.ts";
import type { MissionState } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface WorkExecutionLifecycle {
  bindRuntime(binding: ExecutionRuntimeBinding): Promise<void> | void;
}

export interface WorkExecutionInput {
  state: MissionState;
  workItem: WorkItem;
  contextPacket: ContextPacket;
  attemptId: string;
  executionId: string;
  lifecycle?: WorkExecutionLifecycle;
}

export interface WorkRecoveryInput {
  state: MissionState;
  workItem: WorkItem;
  contextPacket: ContextPacket;
  attemptId: string;
  executionId: string;
  binding: ExecutionRuntimeBinding;
}

export interface WorkExecutionOutcome {
  result: ExecutionResult;
  artifacts: Artifact[];
}

export interface WorkExecutionDriver {
  id: string;
  execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome>;
  recover?(input: WorkRecoveryInput): Promise<WorkExecutionOutcome>;
}
