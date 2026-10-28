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
  }): Promise<{ sourceRefs: string[]; truthRefs: string[] }> {
    if (!input.envelope) return { sourceRefs: [], truthRefs: [] };
    const now = new Date().toISOString();
    const sourceRefs: string[] = [];
    for (let index = 0; index < input.envelope.sources.length; index++) {
      const proposal = input.envelope.sources[index]!;
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
    }

    const knownSources = new Set((await this.projections.listSources(input.work.missionId)).map(source => source.id));
    sourceRefs.forEach(ref => knownSources.add(ref));
    const truthRefs: string[] = [];
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
    }
    return { sourceRefs, truthRefs };
  }
}

function sourceType(value: unknown): SourceType {
  const allowed: SourceType[] = ["web", "file", "github", "document", "api", "user", "other"];
  return allowed.includes(value as SourceType) ? value as SourceType : "other";
}
