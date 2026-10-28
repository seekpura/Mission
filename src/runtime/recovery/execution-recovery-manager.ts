import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { WorkExecutionRouter } from "../orchestration/executor-router.ts";

export interface RecoverySummary { running: string[]; lost: string[]; }

export interface ExecutionRecoveryDependencies {
  controller: MissionController;
  events: EventStore;
  projections: MissionProjectionReader;
  router: WorkExecutionRouter;
}

export class ExecutionRecoveryManager {
  private readonly input: ExecutionRecoveryDependencies;
  constructor(input: ExecutionRecoveryDependencies) { this.input = input; }

  async reconcileMission(missionId: string): Promise<RecoverySummary> {
    const state = await this.input.controller.state(missionId);
    const events = await this.input.events.list(missionId);
    const workItems = await this.input.projections.listWorkItems(missionId);
    const running: string[] = [];
    const lost: string[] = [];
    for (const executionId of state.activeExecutionIds) {
      if (await this.input.router.recover(executionId) === "running") { running.push(executionId); continue; }
      lost.push(executionId);
      const created = events.find(event => event.type === "execution.created" && (event.payload as any)?.id === executionId);
      const workItemId = (created?.payload as any)?.workItemId as string | undefined;
      const work = workItems.find(item => item.id === workItemId);
      await this.input.controller.emit(missionId, "execution.lost", { id: executionId, workItemId, reason: "Execution handle was not recoverable after runtime restart" }, { type: "system" }, `execution-lost:${executionId}`);
      if (work) {
        await this.input.controller.emit(missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution lost during recovery; inspection required before retry" }, { type: "system" }, `work-recovery-wait:${work.id}:${executionId}`);
        await this.input.controller.openGap(missionId, {
          id: `recovery-${executionId}`, severity: "major", category: "runtime",
          description: `Execution ${executionId} was lost during runtime recovery. Inspect workspace and possible side effects before retrying.`,
          requirementRefs: work.requirementRefs, artifactRefs: work.inputArtifactRefs
        });
      }
    }
    return { running, lost };
  }
}
