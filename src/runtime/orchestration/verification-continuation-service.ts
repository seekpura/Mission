import { randomUUID } from "node:crypto";
import type { CapabilityNeed } from "../../core/domain/capability.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { ArtifactAssurancePipeline } from "./artifact-assurance-pipeline.ts";

export interface VerificationContinuationResult {
  status: "completed" | "failed" | "blocked";
  reason: string;
  capabilityNeeds: CapabilityNeed[];
}

export class VerificationContinuationService {
  private readonly controller: MissionController;
  private readonly assurance: ArtifactAssurancePipeline;

  constructor(input: { controller: MissionController; assurance: ArtifactAssurancePipeline }) {
    this.controller = input.controller;
    this.assurance = input.assurance;
  }

  async resume(work: WorkItem): Promise<VerificationContinuationResult> {
    const attemptId = `attempt-${work.id}-${randomUUID().slice(0, 8)}`;
    const executionId = `execution-${work.id}-${randomUUID().slice(0, 8)}`;
    await this.controller.emit(work.missionId, "attempt.created", {
      id: attemptId,
      workItemId: work.id,
      executorId: "assurance-runtime",
      contextPacketId: "verification-continuation"
    }, { type: "controller" }, `attempt:${attemptId}`);
    await this.controller.emit(work.missionId, "work.started", { id: work.id }, { type: "controller" }, `work-started:${work.id}:${attemptId}`);
    await this.controller.emit(work.missionId, "execution.created", {
      id: executionId,
      workItemId: work.id,
      attemptId,
      executorType: "assurance-runtime",
      routeReason: "resume deferred verification against existing candidate artifacts"
    }, { type: "controller" }, `execution-created:${executionId}`);
    await this.controller.emit(work.missionId, "execution.started", { id: executionId, executorType: "assurance-runtime" }, { type: "verifier" }, `execution-started:${executionId}`);

    try {
      const outcome = await this.assurance.reverify(work);
      if (outcome.ok) {
        await this.controller.emit(work.missionId, "execution.completed", { id: executionId, artifactRefs: outcome.artifactRefs }, { type: "verifier" }, `execution-settled:${executionId}`);
        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "succeeded", artifactRefs: outcome.artifactRefs }, { type: "verifier" }, `attempt-completed:${attemptId}`);
        await this.controller.emit(work.missionId, "work.completed", { id: work.id, summary: outcome.reason, artifactRefs: outcome.artifactRefs }, { type: "verifier" }, `work-completed:${work.id}:${attemptId}`);
        for (const gapId of work.gapRefs) await this.controller.resolveGap(work.missionId, gapId);
        return { status: "completed", reason: outcome.reason, capabilityNeeds: [] };
      }

      if (outcome.status === "verification_blocked") {
        const capabilityNeeds = outcome.capabilityNeeds ?? [];
        await this.controller.emit(work.missionId, "execution.completed", { id: executionId, status: "blocked", reason: outcome.reason }, { type: "verifier" }, `execution-settled:${executionId}`);
        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "partial", reason: outcome.reason }, { type: "verifier" }, `attempt-completed:${attemptId}`);
        await this.controller.emit(work.missionId, "work.blocked", { id: work.id, reason: outcome.reason }, { type: "verifier" }, `work-verification-blocked:${work.id}:${attemptId}`);
        if (capabilityNeeds.length > 0) {
          await this.controller.openGap(work.missionId, {
            id: `capability-verification-${work.id}`,
            severity: "major",
            description: `Verification capability remained unavailable after acquisition attempt: ${capabilityNeeds.map(need => need.objective).join("; ")}`,
            category: "capability",
            requirementRefs: work.requirementRefs,
            artifactRefs: work.inputArtifactRefs
          });
        }
        return { status: "blocked", reason: outcome.reason, capabilityNeeds };
      }

      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: outcome.reason }, { type: "verifier" }, `execution-settled:${executionId}`);
      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "failed", reason: outcome.reason }, { type: "verifier" }, `attempt-completed:${attemptId}`);
      await this.controller.emit(work.missionId, "work.failed", { id: work.id, reason: outcome.reason }, { type: "verifier" }, `work-failed:${work.id}:${attemptId}`);
      return { status: "failed", reason: outcome.reason, capabilityNeeds: [] };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: reason }, { type: "verifier" }, `execution-settled:${executionId}`);
      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "failed", reason }, { type: "verifier" }, `attempt-completed:${attemptId}`);
      await this.controller.emit(work.missionId, "work.failed", { id: work.id, reason }, { type: "verifier" }, `work-failed:${work.id}:${attemptId}`);
      return { status: "failed", reason, capabilityNeeds: [] };
    }
  }
}
