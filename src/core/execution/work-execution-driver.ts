import type { Artifact } from "../domain/artifact.ts";
import type { ContextPacket } from "../domain/context.ts";
import type { ExecutionResult } from "../domain/execution.ts";
import type { MissionState } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface WorkExecutionInput {
  state: MissionState;
  workItem: WorkItem;
  contextPacket: ContextPacket;
  attemptId: string;
  executionId: string;
}

export interface WorkExecutionOutcome {
  result: ExecutionResult;
  artifacts: Artifact[];
}

export interface WorkExecutionDriver {
  id: string;
  execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome>;
}
