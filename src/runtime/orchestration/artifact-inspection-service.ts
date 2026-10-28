import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Artifact } from "../../core/domain/artifact.ts";
import type { CapabilityNeed } from "../../core/domain/capability.ts";
import type { InspectionOutcome } from "../../core/domain/inspection.ts";
import type { VerificationProfile } from "../../core/domain/verification.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import { InspectionPlanner } from "../../core/inspection/inspection-planner.ts";
import { InspectionProviderRegistry } from "../../core/inspection/inspection-registry.ts";
import { inspectionCapabilityNeed } from "../../core/inspection/inspection-capability-need.ts";
import { InspectionCapabilityUnavailableError } from "../../core/inspection/capability-backed-inspection-provider.ts";
import type { FileArtifactStore } from "../../execution/artifacts/artifact-store.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";

export class ArtifactInspectionService {
  private readonly controller: MissionController;
  private readonly artifacts: FileArtifactStore;
  private readonly workspaces: WorkspaceManager;
  private readonly registry: InspectionProviderRegistry;
  private readonly planner: InspectionPlanner;

  constructor(input: {
    controller: MissionController;
    artifacts: FileArtifactStore;
    workspaces: WorkspaceManager;
    registry: InspectionProviderRegistry;
    planner?: InspectionPlanner;
  }) {
    this.controller = input.controller;
    this.artifacts = input.artifacts;
    this.workspaces = input.workspaces;
    this.registry = input.registry;
    this.planner = input.planner ?? new InspectionPlanner();
  }

  async prepare(artifact: Artifact, profile: VerificationProfile, missionArtifacts: Artifact[]): Promise<InspectionOutcome> {
    const requests = this.planner.plan(artifact, profile);
    if (requests.length === 0) return { required: false, requests: [], artifacts: [], missingKinds: [], missingCapabilityNeeds: [] };

    const derived: Artifact[] = [];
    const missingKinds = new Set<InspectionOutcome["missingKinds"][number]>();
    const missingCapabilityNeeds = new Map<string, CapabilityNeed>();
    for (const request of requests) {
      const provider = this.registry.resolve(artifact, request);
      if (!provider) {
        missingKinds.add(request.kind);
        mergeNeed(missingCapabilityNeeds, inspectionCapabilityNeed(artifact, request));
        continue;
      }
      const handle = this.workspaces.allocate(
        artifact.missionId,
        `inspection-${safeSegment(artifact.id)}-v${artifact.version}-${safeSegment(request.kind)}-${randomUUID().slice(0, 8)}`
      );
      let bundle;
      try {
        bundle = await provider.inspect(artifact, request, { outputDir: handle.root, missionArtifacts });
      } catch (error) {
        missingKinds.add(request.kind);
        if (error instanceof InspectionCapabilityUnavailableError) mergeNeed(missingCapabilityNeeds, error.need);
        continue;
      }
      const sourceRef = `${artifact.id}@${artifact.version}`;
      if (bundle.sourceArtifactRef !== sourceRef || bundle.products.length === 0) {
        missingKinds.add(request.kind);
        continue;
      }
      let productIndex = 0;
      for (const product of bundle.products) {
        if (product.kind !== request.kind) continue;
        const sourcePath = safeInspectionPath(handle.root, product.path);
        if (!existsSync(sourcePath)) continue;
        const logicalName = [
          "__inspection__",
          safeSegment(artifact.logicalName),
          `v${artifact.version}`,
          safeSegment(bundle.providerId),
          safeSegment(product.kind),
          safeSegment(product.logicalSuffix ?? String(++productIndex))
        ].join("-");
        const inspectionArtifact = this.artifacts.commit({
          missionId: artifact.missionId,
          logicalName,
          type: product.type,
          sourcePath,
          producedByAttemptId: `inspection:${sourceRef}:${bundle.providerId}`,
          sourceArtifactRefs: [sourceRef],
          mimeType: product.mimeType
        });
        await this.controller.emit(
          artifact.missionId,
          "artifact.created",
          { artifact: inspectionArtifact },
          { type: "verifier", id: bundle.providerId },
          `artifact-created:${inspectionArtifact.id}:${inspectionArtifact.version}`
        );
        derived.push(inspectionArtifact);
      }
      if (!derived.some(item => item.sourceArtifactRefs.includes(sourceRef) && item.logicalName.includes(safeSegment(request.kind)))) {
        missingKinds.add(request.kind);
      }
    }

    return {
      required: true,
      requests,
      artifacts: derived,
      missingKinds: [...missingKinds],
      missingCapabilityNeeds: [...missingCapabilityNeeds.values()]
    };
  }
}

function mergeNeed(target: Map<string, CapabilityNeed>, incoming: CapabilityNeed): void {
  const existing = target.get(incoming.id);
  if (!existing) { target.set(incoming.id, incoming); return; }
  target.set(incoming.id, {
    ...existing,
    requirementRefs: [...new Set([...existing.requirementRefs, ...incoming.requirementRefs])],
    requiredFunctions: [...new Set([...existing.requiredFunctions, ...incoming.requiredFunctions])],
    desiredInputs: [...new Set([...existing.desiredInputs, ...incoming.desiredInputs])],
    desiredOutputs: [...new Set([...existing.desiredOutputs, ...incoming.desiredOutputs])]
  });
}

function safeInspectionPath(root: string, candidate: string): string {
  const absolute = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate);
  const rel = relative(resolve(root), absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Inspection product escapes workspace: ${candidate}`);
  return absolute;
}

function safeSegment(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "inspection";
}
