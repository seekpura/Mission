import type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface KnowledgeContextSelection {
  truths: TruthRecord[];
  sources: SourceRecord[];
}

export class KnowledgeContextSelector {
  select(input: { workItem: WorkItem; truths: TruthRecord[]; sources: SourceRecord[] }): KnowledgeContextSelection {
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
    return { truths, sources };
  }
}
