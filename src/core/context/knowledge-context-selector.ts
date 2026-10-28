import type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";
import type { Gap } from "../domain/verification.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface KnowledgeContextSelection {
  truths: TruthRecord[];
  sources: SourceRecord[];
  diagnosticTruths: TruthRecord[];
  diagnosticSources: SourceRecord[];
  relatedGaps: Gap[];
}

export class KnowledgeContextSelector {
  select(input: { workItem: WorkItem; truths: TruthRecord[]; sources: SourceRecord[]; gaps?: Gap[] }): KnowledgeContextSelection {
    const requirementRefs = new Set(input.workItem.requirementRefs);
    const inputArtifactRefs = new Set(input.workItem.inputArtifactRefs);
    const truths = input.truths.filter(truth => {
      if (truth.status !== "active") return false;
      const requirementMatch = truth.requirementRefs.some(ref => requirementRefs.has(ref));
      const artifactMatch = truth.artifactRefs.some(ref => inputArtifactRefs.has(ref));
      return requirementMatch || artifactMatch;
    });
    const sourceRefs = new Set(truths.flatMap(truth => truth.sourceRefs));
    const sources = input.sources.filter(source => source.status === "active" && sourceRefs.has(source.id));

    const relatedGaps = (input.gaps ?? []).filter(gap => input.workItem.gapRefs.includes(gap.id));
    const diagnosticSourceRefs = new Set(relatedGaps.flatMap(gap => gap.sourceRefs ?? []));
    const diagnosticSources = input.sources.filter(source => diagnosticSourceRefs.has(source.id) && source.status !== "active");
    const diagnosticTruths = input.truths.filter(truth =>
      truth.status !== "active" && truth.sourceRefs.some(ref => diagnosticSourceRefs.has(ref))
    );
    return { truths, sources, diagnosticTruths, diagnosticSources, relatedGaps };
  }
}
