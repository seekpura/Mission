import type { MissionController } from "../mission/controller.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { SourceRecord, SourceStatus, TruthRecord, TruthStatus } from "../domain/knowledge.ts";

export class KnowledgeStalenessManager {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;

  constructor(input: { controller: MissionController; projections: MissionProjectionReader }) {
    this.controller = input.controller;
    this.projections = input.projections;
  }

  async registerSource(source: SourceRecord): Promise<void> {
    await this.controller.emit(source.missionId, "source.registered", { source }, { type: "worker" }, `source:${source.id}:${source.contentHash ?? source.capturedAt}`);
  }

  async recordTruth(truth: TruthRecord): Promise<void> {
    await this.controller.emit(truth.missionId, "truth.added", { truth }, { type: "worker" }, `truth:${truth.id}`);
  }

  async markSourceStatus(missionId: string, sourceId: string, status: SourceStatus, reason: string): Promise<{
    truthRefs: string[];
    artifactRefs: string[];
    requirementRefs: string[];
    evidenceRefs: string[];
    gapId?: string;
  }> {
    const sources = await this.projections.listSources(missionId);
    const source = sources.find(item => item.id === sourceId);
    if (!source) throw new Error(`Unknown source: ${sourceId}`);
    if (source.status === status) return { truthRefs: [], artifactRefs: [], requirementRefs: [], evidenceRefs: [] };

    await this.controller.emit(missionId, "source.status.changed", { id: sourceId, status, reason }, { type: "controller" }, `source-status:${sourceId}:${status}`);
    if (status === "active") return { truthRefs: [], artifactRefs: [], requirementRefs: [], evidenceRefs: [] };

    const truthStatus = truthStatusForSource(status);
    const truths = (await this.projections.listTruths(missionId))
      .filter(truth => truth.sourceRefs.includes(sourceId) && !["superseded", "invalidated"].includes(truth.status));
    const truthRefs: string[] = [];
    const artifactRefs = new Set<string>();
    const requirementRefs = new Set<string>();
    for (const truth of truths) {
      truthRefs.push(truth.id);
      truth.artifactRefs.forEach(ref => artifactRefs.add(ref));
      truth.requirementRefs.forEach(ref => requirementRefs.add(ref));
      await this.controller.emit(missionId, "truth.status.changed", {
        id: truth.id,
        status: truthStatus,
        reason: `Source ${sourceId} is ${status}: ${reason}`
      }, { type: "controller" }, `truth-status:${truth.id}:${truthStatus}:${sourceId}`);
    }

    const evidence = await this.projections.listEvidence(missionId);
    const evidenceRefs = new Set<string>();
    for (const item of evidence) {
      if ((item.sourceRef === sourceId || truthRefs.includes(item.sourceRef ?? "")) && (item.validity ?? "active") === "active") {
        evidenceRefs.add(item.id);
        await this.controller.emit(missionId, "evidence.invalidated", {
          id: item.id,
          reason: `Source ${sourceId} is ${status}: ${reason}`
        }, { type: "controller" }, `evidence-invalidated:${item.id}:${sourceId}:${status}`);
      }
    }

    const requirements = await this.projections.listRequirements(missionId);
    for (const requirement of requirements) {
      const linkedByTruth = requirementRefs.has(requirement.id);
      const linkedByEvidence = requirement.evidenceRefs.some(ref => evidenceRefs.has(ref));
      if (!linkedByTruth && !linkedByEvidence) continue;
      requirementRefs.add(requirement.id);
      if (requirement.status === "satisfied") {
        await this.controller.setRequirementStatus(missionId, requirement.id, "unverified", requirement.evidenceRefs);
      }
    }

    const artifacts = await this.projections.listArtifacts(missionId);
    for (const artifactRef of artifactRefs) {
      const artifact = artifacts.find(item => `${item.id}@${item.version}` === artifactRef);
      if (!artifact || artifact.status === "invalid" || artifact.status === "superseded") continue;
      await this.controller.emit(missionId, "artifact.invalidated", {
        artifactRef,
        reason: `Dependent source ${sourceId} is ${status}: ${reason}`
      }, { type: "controller" }, `source-artifact-invalidated:${sourceId}:${artifactRef}:${status}`);
    }

    const affectedRequirements = [...requirementRefs];
    const affectedArtifacts = [...artifactRefs];
    if (affectedRequirements.length === 0 && affectedArtifacts.length === 0 && truthRefs.length === 0) {
      return { truthRefs, artifactRefs: affectedArtifacts, requirementRefs: affectedRequirements, evidenceRefs: [...evidenceRefs] };
    }

    const severity = requirementSeverity(requirements, affectedRequirements);
    const gapId = `stale-source:${sourceId}`;
    await this.controller.openGap(missionId, {
      id: gapId,
      severity,
      category: truthRefs.length > 0 ? "fact" : "evidence",
      description: `Source ${sourceId} became ${status}; dependent truth/evidence must be refreshed before acceptance`,
      requirementRefs: affectedRequirements,
      artifactRefs: affectedArtifacts,
      sourceRefs: [sourceId],
      findingRefs: []
    });

    const state = await this.controller.state(missionId);
    if (state.status === "completed") {
      await this.controller.emit(missionId, "mission.reopened", {
        reason: `Source ${sourceId} became ${status} and invalidated accepted evidence`
      }, { type: "controller" }, `mission-reopened:source:${sourceId}:${status}`);
    }

    return { truthRefs, artifactRefs: affectedArtifacts, requirementRefs: affectedRequirements, evidenceRefs: [...evidenceRefs], gapId };
  }

  async scanFreshness(missionId: string, now = new Date()): Promise<string[]> {
    const stale: string[] = [];
    for (const source of await this.projections.listSources(missionId)) {
      if (source.status !== "active" || !source.freshUntil) continue;
      const expires = Date.parse(source.freshUntil);
      if (!Number.isFinite(expires) || expires >= now.getTime()) continue;
      await this.markSourceStatus(missionId, source.id, "stale", `freshUntil ${source.freshUntil} elapsed`);
      stale.push(source.id);
    }
    return stale;
  }
}

function truthStatusForSource(status: SourceStatus): TruthStatus {
  return status === "unavailable" ? "invalidated" : "stale";
}

function requirementSeverity(requirements: Awaited<ReturnType<MissionProjectionReader["listRequirements"]>>, ids: string[]): "critical" | "major" | "minor" {
  const affected = requirements.filter(item => ids.includes(item.id));
  if (affected.some(item => item.priority === "critical")) return "critical";
  if (affected.some(item => item.priority === "required")) return "major";
  return "minor";
}
