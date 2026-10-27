import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact } from "../../core/domain/artifact.ts";
import type { Evidence, Finding, VerificationResult } from "../../core/domain/verification.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import type { FileArtifactStore } from "../../execution/artifacts/artifact-store.ts";
import type { Verifier } from "../../core/verification/verifier.ts";

export interface ArtifactPipelineResult {
  ok: boolean;
  reason: string;
  artifactRefs: string[];
}

export class ArtifactAssurancePipeline {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly artifacts: FileArtifactStore;
  private readonly verifier: Verifier;

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    artifacts: FileArtifactStore;
    verifier: Verifier;
  }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.artifacts = input.artifacts;
    this.verifier = input.verifier;
  }

  async process(work: WorkItem, attemptId: string, workspaceRoot: string, envelope: WorkerOutputEnvelope | null): Promise<ArtifactPipelineResult> {
    const outputs = envelope?.outputs ?? [];
    if (work.expectedOutputs.some(expected => expected.required) && outputs.length === 0) {
      await this.openGap(work, "missing-output", "Worker completed without required output files", "missing_output");
      return { ok: false, reason: "required outputs were not produced", artifactRefs: [] };
    }
    const artifactRefs: string[] = [];
    for (const output of outputs) {
      const sourcePath = this.safeWorkspacePath(workspaceRoot, output.path);
      if (!existsSync(sourcePath)) {
        await this.openGap(work, `missing-${output.logicalName}`, `Worker reported missing file ${output.path}`, "missing_output");
        return { ok: false, reason: `reported output does not exist: ${output.path}`, artifactRefs };
      }
      const artifact = this.artifacts.commit({
        missionId: work.missionId,
        logicalName: output.logicalName,
        type: output.type,
        sourcePath,
        producedByAttemptId: attemptId,
        sourceArtifactRefs: work.inputArtifactRefs
      });
      await this.controller.recordArtifact(work.missionId, artifact);
      const verification = await this.verifier.verify(artifact);
      await this.controller.recordVerification(work.missionId, verification);
      if (verification.overall === "fail" || verification.overall === "inconclusive") {
        const finding = this.verificationFinding(artifact, verification);
        await this.controller.emit(work.missionId, "finding.created", { finding }, { type: "verifier" }, `finding:${finding.id}`);
        await this.controller.openGap(work.missionId, {
          id: `verification-${artifact.id}-${artifact.version}`,
          severity: "major",
          description: finding.observation,
          category: "quality",
          artifactRefs: [`${artifact.id}@${artifact.version}`],
          findingRefs: [finding.id],
          requirementRefs: output.requirementRefs ?? []
        });
        return { ok: false, reason: `artifact verification failed: ${artifact.logicalName}`, artifactRefs };
      }
      const evidence = this.verificationEvidence(artifact, verification);
      await this.controller.recordEvidence(work.missionId, evidence);
      const final = await this.isRequiredArtifact(work.missionId, artifact);
      await this.controller.validateArtifact(work.missionId, `${artifact.id}@${artifact.version}`, final);
      artifactRefs.push(`${artifact.id}@${artifact.version}`);
      await this.satisfyArtifactRequirements(work.missionId, artifact, output.requirementRefs ?? [], evidence.id);
    }
    if (outputs.length === 0 && work.expectedOutputs.length === 0) return { ok: true, reason: "non-artifact work completed", artifactRefs };
    return { ok: true, reason: "outputs verified", artifactRefs };
  }

  async openGap(work: WorkItem, suffix: string, description: string, category: "runtime" | "missing_output"): Promise<void> {
    await this.controller.openGap(work.missionId, {
      id: `gap-${work.id}-${suffix}`,
      severity: work.purpose === "exploration" ? "minor" : "major",
      description,
      category,
      requirementRefs: work.requirementRefs,
      artifactRefs: work.inputArtifactRefs
    });
  }

  private async satisfyArtifactRequirements(missionId: string, artifact: Artifact, explicitRequirementRefs: string[], evidenceId: string): Promise<void> {
    const contract = await this.projections.getAcceptanceContract(missionId);
    const requirements = await this.projections.listRequirements(missionId);
    const requiredArtifact = contract?.requiredArtifacts.find(item => item.logicalName === artifact.logicalName && (!item.type || item.type === artifact.type));
    const candidates = new Set([...(requiredArtifact?.requirementRefs ?? []), ...explicitRequirementRefs]);
    for (const requirement of requirements) {
      if (!candidates.has(requirement.id)) continue;
      if (requirement.verification !== "artifact") continue;
      await this.controller.setRequirementStatus(missionId, requirement.id, "satisfied", [evidenceId]);
    }
  }

  private async isRequiredArtifact(missionId: string, artifact: Artifact): Promise<boolean> {
    const contract = await this.projections.getAcceptanceContract(missionId);
    return !!contract?.requiredArtifacts.some(item => item.logicalName === artifact.logicalName && (!item.type || item.type === artifact.type));
  }

  private verificationEvidence(artifact: Artifact, verification: VerificationResult): Evidence {
    return {
      id: `evidence-${verification.id}`,
      missionId: artifact.missionId,
      subjectRef: `${artifact.id}@${artifact.version}`,
      type: "file-validation",
      claim: `${artifact.logicalName} passed ${verification.verificationProfileId} verification`,
      result: "supports",
      sourceRef: verification.id,
      producedBy: verification.verifierId,
      createdAt: new Date().toISOString()
    };
  }

  private verificationFinding(artifact: Artifact, verification: VerificationResult): Finding {
    return {
      id: `finding-${verification.id}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      category: "structural",
      severity: "major",
      observation: `${artifact.logicalName} failed structural verification`,
      expected: "Artifact exists, is non-empty, and passes its required verifier profile",
      requirementRefs: [],
      evidenceRefs: verification.evidenceRefs,
      confidence: 1,
      createdAt: new Date().toISOString()
    };
  }

  private safeWorkspacePath(workspaceRoot: string, outputPath: string): string {
    const absolute = isAbsolute(outputPath) ? resolve(outputPath) : resolve(workspaceRoot, outputPath);
    const rel = relative(resolve(workspaceRoot), absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Worker output escapes workspace: ${outputPath}`);
    return absolute;
  }
}
