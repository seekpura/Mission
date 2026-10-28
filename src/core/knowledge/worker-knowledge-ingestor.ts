import type { WorkerOutputEnvelope } from "../execution/worker-output.ts";
import type { SourceRecord, SourceType, TruthRecord } from "../domain/knowledge.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { KnowledgeStalenessManager } from "./knowledge-staleness-manager.ts";

export class WorkerKnowledgeIngestor {
  private readonly knowledge: KnowledgeStalenessManager;
  private readonly projections: MissionProjectionReader;

  constructor(input: { knowledge: KnowledgeStalenessManager; projections: MissionProjectionReader }) {
    this.knowledge = input.knowledge;
    this.projections = input.projections;
  }

  async ingest(input: {
    work: WorkItem;
    attemptId: string;
    envelope: WorkerOutputEnvelope | null;
    artifactRefs: string[];
  }): Promise<{ sourceRefs: string[]; truthRefs: string[]; supersededSourceRefs: string[]; supersededTruthRefs: string[] }> {
    if (!input.envelope) return { sourceRefs: [], truthRefs: [], supersededSourceRefs: [], supersededTruthRefs: [] };
    const now = new Date().toISOString();
    const sourceRefs: string[] = [];
    const sourceReplacements: Array<{ oldRef: string; newRef: string }> = [];
    const sourceProposals = input.envelope.sources ?? [];
    for (let index = 0; index < sourceProposals.length; index++) {
      const proposal = sourceProposals[index]!;
      const id = proposal.id?.trim() || `source-${input.attemptId}-${index + 1}`;
      const source: SourceRecord = {
        id,
        missionId: input.work.missionId,
        type: sourceType(proposal.type),
        uri: proposal.uri,
        localRef: proposal.localRef,
        title: proposal.title,
        capturedAt: proposal.capturedAt ?? now,
        version: proposal.version,
        commit: proposal.commit,
        authority: proposal.authority,
        freshUntil: proposal.freshUntil,
        contentHash: proposal.contentHash,
        status: "active",
        metadata: proposal.metadata ?? {}
      };
      await this.knowledge.registerSource(source);
      sourceRefs.push(id);
      if (proposal.replacesSourceRef) sourceReplacements.push({ oldRef: proposal.replacesSourceRef, newRef: id });
    }

    const knownSources = new Set((await this.projections.listSources(input.work.missionId)).filter(source => source.status === "active").map(source => source.id));
    sourceRefs.forEach(ref => knownSources.add(ref));
    const truthRefs: string[] = [];
    const truthReplacements: Array<{ oldRef: string; newRef: string }> = [];
    for (let index = 0; index < input.envelope.proposedFacts.length; index++) {
      const proposal = input.envelope.proposedFacts[index]!;
      if (!proposal || typeof proposal.key !== "string" || !proposal.key.trim()) continue;
      const requestedSourceRefs = (proposal.sourceRefs ?? []).filter(Boolean);
      const verifiedSources = requestedSourceRefs.filter(ref => knownSources.has(ref));
      const fullySourced = requestedSourceRefs.length > 0 && verifiedSources.length === requestedSourceRefs.length;
      const truth: TruthRecord = {
        id: `truth-${input.attemptId}-${index + 1}`,
        missionId: input.work.missionId,
        key: proposal.key.trim(),
        value: proposal.value,
        source: fullySourced ? "source" : "inference",
        sourceRefs: verifiedSources,
        confidence: fullySourced ? "verified" : "assumed",
        status: "active",
        requirementRefs: [...new Set(proposal.requirementRefs ?? [])],
        artifactRefs: [...new Set(input.artifactRefs)],
        createdAt: now
      };
      await this.knowledge.recordTruth(truth);
      truthRefs.push(truth.id);
      if (proposal.supersedesTruthRef) {
        if (!fullySourced) throw new Error(`Unsourced truth cannot supersede ${proposal.supersedesTruthRef}`);
        truthReplacements.push({ oldRef: proposal.supersedesTruthRef, newRef: truth.id });
      }
    }

    const supersededSourceRefs: string[] = [];
    for (const replacement of sourceReplacements) {
      await this.knowledge.supersedeSource(input.work.missionId, replacement.oldRef, replacement.newRef);
      supersededSourceRefs.push(replacement.oldRef);
    }
    const supersededTruthRefs: string[] = [];
    for (const replacement of truthReplacements) {
      await this.knowledge.supersedeTruth(input.work.missionId, replacement.oldRef, replacement.newRef);
      supersededTruthRefs.push(replacement.oldRef);
    }
    return { sourceRefs, truthRefs, supersededSourceRefs, supersededTruthRefs };
  }
}

function sourceType(value: unknown): SourceType {
  const allowed: SourceType[] = ["web", "file", "github", "document", "api", "user", "other"];
  return allowed.includes(value as SourceType) ? value as SourceType : "other";
}
