import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { InvocationReceipt, InvocationRoute } from "../../core/domain/invocation.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { WorkExecutionRouter } from "../orchestration/executor-router.ts";
import type { ArtifactAssurancePipeline } from "../orchestration/artifact-assurance-pipeline.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import { RecoveryObservationInspector } from "./recovery-observation-inspector.ts";

export interface RecoverySummary { running: string[]; recovered: string[]; lost: string[]; }

export interface ExecutionRecoveryDependencies {
  controller: MissionController;
  events: EventStore;
  projections: MissionProjectionReader;
  router: WorkExecutionRouter;
  workspaces: WorkspaceManager;
  assurance: ArtifactAssurancePipeline;
}

export class ExecutionRecoveryManager {
  private readonly input: ExecutionRecoveryDependencies;
  private readonly inspector: RecoveryObservationInspector;
  constructor(input: ExecutionRecoveryDependencies) {
    this.input = input;
    this.inspector = new RecoveryObservationInspector(input.workspaces);
  }

  async reconcileMission(missionId: string): Promise<RecoverySummary> {
    const state = await this.input.controller.state(missionId);
    const events = await this.input.events.list(missionId);
    const workItems = await this.input.projections.listWorkItems(missionId);
    const running: string[] = [];
    const recovered: string[] = [];
    const lost: string[] = [];
    for (const executionId of state.activeExecutionIds) {
      if (await this.input.router.recover(executionId) === "running") { running.push(executionId); continue; }
      const created = events.find(event => event.type === "execution.created" && (event.payload as any)?.id === executionId);
      const workItemId = (created?.payload as any)?.workItemId as string | undefined;
      const attemptId = (created?.payload as any)?.attemptId as string | undefined;
      const work = workItems.find(item => item.id === workItemId);
      if (work && attemptId) {
        const observation = this.inspector.inspect(work, attemptId, executionId);
        if (observation.kind === "recoverable") {
          const outcome = await this.input.assurance.process(work, attemptId, observation.workspaceRoot, observation.envelope);
          if (outcome.ok) {
            await this.recordRecoveredInvocation(missionId, executionId, work, attemptId, events, observation.manifest);
            await this.input.controller.emit(missionId, "execution.completed", { id: executionId, recovered: true, artifactRefs: outcome.artifactRefs, source: observation.source }, { type: "system" }, `execution-settled:${executionId}`);
            await this.input.controller.emit(missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: observation.envelope.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs, recovered: true }, { type: "system" }, `attempt-completed:${attemptId}`);
            await this.input.controller.emit(missionId, "work.completed", { id: work.id, summary: observation.envelope.summary || "Recovered completed work from workspace observation", artifactRefs: outcome.artifactRefs, recovered: true }, { type: "system" }, `work-completed:${work.id}:${attemptId}`);
            if (work.purpose === "repair" && outcome.artifactRefs.length > 0) for (const gapId of work.gapRefs) await this.input.controller.resolveGap(missionId, gapId);
            recovered.push(executionId);
            continue;
          }
          await this.markLost(missionId, executionId, work, `Recovered output evidence failed artifact verification; preserved workspace ${observation.workspaceRoot}`);
          lost.push(executionId);
          continue;
        }
        const reason = observation.kind === "partial"
          ? `${observation.reason}; preserved workspace ${observation.workspaceRoot}; files=${observation.files.join(",") || "none"}`
          : observation.reason;
        await this.markLost(missionId, executionId, work, reason);
        lost.push(executionId);
        continue;
      }
      await this.markLost(missionId, executionId, work, "Execution handle was not recoverable and its WorkItem/Attempt identity could not be reconstructed");
      lost.push(executionId);
    }
    return { running, recovered, lost };
  }

  private async recordRecoveredInvocation(missionId: string, executionId: string, work: WorkItem, attemptId: string, events: Awaited<ReturnType<EventStore["list"]>>, manifest: any): Promise<void> {
    const routeEvent = events.find(event => event.type === "execution.route.selected" && (event.payload as any)?.executionId === executionId);
    const routePayload = (routeEvent?.payload ?? {}) as any;
    const route = (manifest?.route ?? routePayload.route ?? "host_agent") as InvocationRoute;
    const now = new Date().toISOString();
    const receipt: InvocationReceipt = {
      id: `invocation-${executionId}`, missionId, workItemId: work.id, attemptId, executionId,
      route, routeReason: manifest?.routeReason ?? routePayload.reason ?? "Recovered from persisted workspace evidence",
      capabilityRefs: manifest?.capabilityRefs ?? routePayload.capabilityRefs ?? [], targetRef: manifest?.targetRef ?? routePayload.targetRef,
      idempotencyKey: `${missionId}:${work.id}:${attemptId}`, approvalRef: manifest?.approvalRef,
      sideEffects: manifest?.sideEffects ?? [], result: "succeeded",
      startedAt: manifest?.startedAt ?? routeEvent?.createdAt ?? now, endedAt: manifest?.endedAt ?? now, createdAt: now
    };
    await this.input.controller.emit(missionId, "execution.invocation.recorded", { receipt, recovered: true }, { type: "system" }, `invocation:${executionId}`);
  }

  private async markLost(missionId: string, executionId: string, work: WorkItem | undefined, reason: string): Promise<void> {
    await this.input.controller.emit(missionId, "execution.lost", { id: executionId, workItemId: work?.id, reason }, { type: "system" }, `execution-lost:${executionId}`);
    if (!work) return;
    await this.input.controller.emit(missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution lost during recovery; inspection required before retry" }, { type: "system" }, `work-recovery-wait:${work.id}:${executionId}`);
    await this.input.controller.openGap(missionId, {
      id: `recovery-${executionId}`, severity: "major", category: "runtime",
      description: `${reason}. Do not retry blindly; inspect workspace and possible side effects first.`,
      requirementRefs: work.requirementRefs, artifactRefs: work.inputArtifactRefs
    });
  }
}
