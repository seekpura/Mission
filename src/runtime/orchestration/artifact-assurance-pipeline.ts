import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact } from "../../core/domain/artifact.ts";
import type { CapabilityNeed } from "../../core/domain/capability.ts";
import type { InspectionOutcome } from "../../core/domain/inspection.ts";
import type { Evidence, Finding, VerificationResult } from "../../core/domain/verification.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import { InspectionPlanner } from "../../core/inspection/inspection-planner.ts";
import { inspectionCapabilityNeed } from "../../core/inspection/inspection-capability-need.ts";
import type { FileArtifactStore } from "../../execution/artifacts/artifact-store.ts";
import type { Verifier } from "../../core/verification/verifier.ts";
import type { ArtifactInspectionService } from "./artifact-inspection-service.ts";

export interface ArtifactPipelineResult {
  ok: boolean;
  status?: "verified" | "failed" | "verification_blocked";
  reason: string;
  artifactRefs: string[];
  capabilityNeeds?: CapabilityNeed[];
}

interface ArtifactVerificationOutcome {
  status: "verified" | "failed" | "verification_blocked";
  reason: string;
  artifactRef: string;
  capabilityNeeds: CapabilityNeed[];
}

export class ArtifactAssurancePipeline {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly artifacts: FileArtifactStore;
  private readonly verifier: Verifier;
  private readonly inspectionService?: ArtifactInspectionService;
  private readonly inspectionPlanner = new InspectionPlanner();

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    artifacts: FileArtifactStore;
    verifier: Verifier;
    inspectionService?: ArtifactInspectionService;
  }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.artifacts = input.artifacts;
    this.verifier = input.verifier;
    this.inspectionService = input.inspectionService;
  }

  async process(work: WorkItem, attemptId: string, workspaceRoot: string, envelope: WorkerOutputEnvelope | null): Promise<ArtifactPipelineResult> {
    const outputs = envelope?.outputs ?? [];
    if (work.expectedOutputs.some(expected => expected.required) && outputs.length === 0) {
      await this.openGap(work, "missing-output", "Worker completed without required output files", "missing_output");
      return { ok: false, status: "failed", reason: "required outputs were not produced", artifactRefs: [] };
    }
    const artifactRefs: string[] = [];
    const blockedNeeds = new Map<string, CapabilityNeed>();
    let verificationBlocked = false;
    for (const output of outputs) {
      const sourcePath = this.safeWorkspacePath(workspaceRoot, output.path);
      if (!existsSync(sourcePath)) {
        await this.openGap(work, `missing-${output.logicalName}`, `Worker reported missing file ${output.path}`, "missing_output");
        return { ok: false, status: "failed", reason: `reported output does not exist: ${output.path}`, artifactRefs };
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
      const verification = await this.verifyArtifact(artifact, output.requirementRefs ?? []);
      artifactRefs.push(verification.artifactRef);
      if (verification.status === "verification_blocked") {
        verificationBlocked = true;
        for (const need of verification.capabilityNeeds) blockedNeeds.set(need.id, mergeCapabilityNeed(blockedNeeds.get(need.id), need));
        await this.deferVerification(work, artifact, verification.capabilityNeeds, output.requirementRefs ?? []);
        continue;
      }
      if (verification.status === "failed") {
        return { ok: false, status: "failed", reason: verification.reason, artifactRefs };
      }
    }
    if (outputs.length === 0 && work.expectedOutputs.length === 0) return { ok: true, status: "verified", reason: "non-artifact work completed", artifactRefs };
    if (verificationBlocked) {
      return {
        ok: true,
        status: "verification_blocked",
        reason: "production completed; artifact verification deferred until required QA capabilities are available",
        artifactRefs,
        capabilityNeeds: [...blockedNeeds.values()]
      };
    }
    return { ok: true, status: "verified", reason: "outputs verified", artifactRefs };
  }

  async reverify(work: WorkItem): Promise<ArtifactPipelineResult> {
    if (work.inputArtifactRefs.length === 0) return { ok: false, status: "failed", reason: "verification work has no input artifacts", artifactRefs: [] };
    const artifacts = await this.projections.listArtifacts(work.missionId);
    const verifiedRefs: string[] = [];
    const needs = new Map<string, CapabilityNeed>();
    for (const artifactRef of work.inputArtifactRefs) {
      const artifact = findArtifact(artifacts, artifactRef);
      if (!artifact) return { ok: false, status: "failed", reason: `verification input artifact not found: ${artifactRef}`, artifactRefs: verifiedRefs };
      const outcome = await this.verifyArtifact(artifact, work.requirementRefs);
      verifiedRefs.push(outcome.artifactRef);
      for (const need of outcome.capabilityNeeds) needs.set(need.id, mergeCapabilityNeed(needs.get(need.id), need));
      if (outcome.status === "failed") return { ok: false, status: "failed", reason: outcome.reason, artifactRefs: verifiedRefs };
      if (outcome.status === "verification_blocked") {
        return { ok: false, status: "verification_blocked", reason: outcome.reason, artifactRefs: verifiedRefs, capabilityNeeds: [...needs.values()] };
      }
    }
    return { ok: true, status: "verified", reason: "existing artifacts verified", artifactRefs: verifiedRefs };
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

  private async verifyArtifact(artifact: Artifact, explicitRequirementRefs: string[]): Promise<ArtifactVerificationOutcome> {
    const contract = await this.projections.getAcceptanceContract(artifact.missionId);
    const requirements = await this.projections.listRequirements(artifact.missionId);
    let missionArtifacts = await this.projections.listArtifacts(artifact.missionId);
    const priorVerifications = await this.projections.listVerificationResults(artifact.missionId);
    const baseContext = {
      acceptanceContract: contract,
      requirements,
      explicitRequirementRefs,
      artifacts: missionArtifacts,
      priorVerifications
    };
    let inspection: InspectionOutcome | undefined;
    const profile = this.verifier.plan?.(artifact, baseContext);
    if (profile) {
      if (this.inspectionService) {
        inspection = await this.inspectionService.prepare(artifact, profile, missionArtifacts);
        if (inspection.artifacts.length > 0) missionArtifacts = await this.projections.listArtifacts(artifact.missionId);
      } else {
        const requests = this.inspectionPlanner.plan(artifact, profile);
        inspection = {
          required: requests.length > 0,
          requests,
          artifacts: [],
          missingKinds: [...new Set(requests.map(request => request.kind))],
          missingCapabilityNeeds: requests.map(request => inspectionCapabilityNeed(artifact, request))
        };
      }
    }
    const verification = await this.verifier.verify(artifact, { ...baseContext, artifacts: missionArtifacts, inspection });
    await this.controller.recordVerification(artifact.missionId, verification);
    if (verification.overall === "fail" || verification.overall === "inconclusive") {
      const finding = this.verificationFinding(artifact, verification);
      await this.controller.emit(artifact.missionId, "finding.created", { finding }, { type: "verifier" }, `finding:${finding.id}`);
      const capabilityNeeds = inspection?.missingCapabilityNeeds ?? [];
      if (capabilityNeeds.length > 0 && verification.overall === "inconclusive") {
        return {
          status: "verification_blocked",
          reason: `verification blocked by missing inspection capability: ${capabilityNeeds.map(need => need.objective).join("; ")}`,
          artifactRef: `${artifact.id}@${artifact.version}`,
          capabilityNeeds
        };
      }
      await this.controller.openGap(artifact.missionId, {
        id: `verification-${artifact.id}-${artifact.version}`,
        severity: finding.severity === "critical" ? "critical" : "major",
        description: finding.observation,
        category: "quality",
        artifactRefs: [`${artifact.id}@${artifact.version}`],
        findingRefs: [finding.id],
        requirementRefs: explicitRequirementRefs
      });
      return { status: "failed", reason: `artifact verification failed: ${artifact.logicalName}`, artifactRef: `${artifact.id}@${artifact.version}`, capabilityNeeds: [] };
    }
    const evidenceIds = await this.recordVerificationEvidence(artifact, verification);
    const final = await this.isRequiredArtifact(artifact.missionId, artifact);
    await this.controller.validateArtifact(artifact.missionId, `${artifact.id}@${artifact.version}`, final);
    await this.satisfyArtifactRequirements(artifact.missionId, artifact, explicitRequirementRefs, verification, evidenceIds);
    return { status: "verified", reason: "artifact verified", artifactRef: `${artifact.id}@${artifact.version}`, capabilityNeeds: [] };
  }

  private async deferVerification(origin: WorkItem, artifact: Artifact, needs: CapabilityNeed[], requirementRefs: string[]): Promise<void> {
    const existingNeeds = await this.projections.listCapabilityNeeds(origin.missionId);
    const needRefs: string[] = [];
    for (const need of needs) {
      const existing = existingNeeds.find(item => item.id === need.id);
      const selected = existing ?? need;
      needRefs.push(selected.id);
      if (!existing) {
        await this.controller.emit(origin.missionId, "capability.need.created", { need }, { type: "verifier" }, `capability-need:${need.id}`);
      }
    }
    const artifactRef = `${artifact.id}@${artifact.version}`;
    const workId = `verify-${safeId(artifact.id)}-v${artifact.version}`;
    const existingWork = (await this.projections.listWorkItems(origin.missionId)).find(item => item.id === workId);
    if (existingWork) return;
    const now = new Date().toISOString();
    await this.controller.proposeWork({
      id: workId,
      missionId: origin.missionId,
      workstreamId: origin.workstreamId,
      parentWorkItemId: origin.id,
      purpose: "verification",
      objective: `Complete deferred verification for ${artifact.logicalName} without regenerating the artifact`,
      status: "ready",
      requirementRefs: [...new Set(requirementRefs)],
      gapRefs: [],
      inputArtifactRefs: [artifactRef],
      expectedOutputs: [],
      localAcceptanceCriteria: [{ id: `verify-${safeId(artifact.id)}-${artifact.version}`, description: "Existing candidate artifact passes all required checks and is promoted without production rerun", priority: "required" }],
      capabilityNeedRefs: [...new Set(needRefs)],
      priority: 100,
      graphRevision: origin.graphRevision,
      createdBy: "verifier",
      createdAt: now,
      updatedAt: now
    });
  }

  private async satisfyArtifactRequirements(missionId: string, artifact: Artifact, explicitRequirementRefs: string[], verification: VerificationResult, evidenceByRequirement: Map<string, string[]>): Promise<void> {
    const contract = await this.projections.getAcceptanceContract(missionId);
    const requirements = await this.projections.listRequirements(missionId);
    const requiredArtifact = contract?.requiredArtifacts.find(item => item.logicalName === artifact.logicalName && (!item.type || item.type === artifact.type));
    const candidates = new Set([...(requiredArtifact?.requirementRefs ?? []), ...explicitRequirementRefs]);
    for (const requirement of requirements) {
      if (!candidates.has(requirement.id)) continue;
      if (requirement.verification === "artifact") {
        const structuralPass = verification.checkResults.filter(check => check.method === "deterministic").every(check => check.status === "pass");
        if (structuralPass) await this.controller.setRequirementStatus(missionId, requirement.id, "satisfied", evidenceByRequirement.get(requirement.id) ?? []);
        continue;
      }
      const relevant = verification.checkResults.filter(check => check.requirementRefs?.includes(requirement.id));
      if (relevant.length > 0 && relevant.every(check => check.status === "pass")) {
        await this.controller.setRequirementStatus(missionId, requirement.id, "satisfied", evidenceByRequirement.get(requirement.id) ?? []);
      }
    }
  }

  private async recordVerificationEvidence(artifact: Artifact, verification: VerificationResult): Promise<Map<string, string[]>> {
    const byRequirement = new Map<string, string[]>();
    for (const check of verification.checkResults.filter(check => check.status === "pass")) {
      const evidence: Evidence = {
        id: `evidence-${verification.id}-${check.id}`, missionId: artifact.missionId, subjectRef: `${artifact.id}@${artifact.version}`,
        type: check.method === "runtime" ? "test-result" : check.method === "perceptual" ? "render-inspection" : check.method === "deterministic" ? "file-validation" : "automated-review",
        claim: `${artifact.logicalName} passed ${check.id}`, result: "supports", sourceRef: verification.id, producedBy: verification.verifierId, createdAt: new Date().toISOString()
      };
      await this.controller.recordEvidence(artifact.missionId, evidence);
      for (const requirementRef of check.requirementRefs ?? []) {
        const refs = byRequirement.get(requirementRef) ?? []; refs.push(evidence.id); byRequirement.set(requirementRef, refs);
      }
    }
    return byRequirement;
  }

  private async isRequiredArtifact(missionId: string, artifact: Artifact): Promise<boolean> {
    const contract = await this.projections.getAcceptanceContract(missionId);
    return !!contract?.requiredArtifacts.some(item => item.logicalName === artifact.logicalName && (!item.type || artifact.type === item.type));
  }

  private verificationFinding(artifact: Artifact, verification: VerificationResult): Finding {
    const failedCheck = verification.checkResults.find(check => check.status === "fail" || check.status === "inconclusive");
    return {
      id: `finding-${verification.id}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      category: failedCheck?.category ?? "structural",
      severity: failedCheck?.priority === "critical" ? "critical" : "major",
      observation: failedCheck?.detail ?? `${artifact.logicalName} did not pass required verification`,
      expected: failedCheck ? `Pass required check: ${failedCheck.id}` : "Artifact passes its required verifier profile",
      requirementRefs: failedCheck?.requirementRefs ?? [],
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

function findArtifact(artifacts: Artifact[], ref: string): Artifact | undefined {
  const split = ref.lastIndexOf("@");
  if (split <= 0) return undefined;
  const id = ref.slice(0, split); const version = Number(ref.slice(split + 1));
  return artifacts.find(artifact => artifact.id === id && artifact.version === version);
}

function mergeCapabilityNeed(existing: CapabilityNeed | undefined, incoming: CapabilityNeed): CapabilityNeed {
  if (!existing) return incoming;
  return {
    ...existing,
    requirementRefs: [...new Set([...existing.requirementRefs, ...incoming.requirementRefs])],
    requiredFunctions: [...new Set([...existing.requiredFunctions, ...incoming.requiredFunctions])],
    desiredInputs: [...new Set([...existing.desiredInputs, ...incoming.desiredInputs])],
    desiredOutputs: [...new Set([...existing.desiredOutputs, ...incoming.desiredOutputs])]
  };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "artifact";
}
