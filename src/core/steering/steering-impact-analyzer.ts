import type { Artifact } from "../domain/artifact.ts";
import type { SteeringInterpretation, SteeringImpact } from "../domain/steering.ts";
import type { WorkItem } from "../domain/work-item.ts";

export class SteeringImpactAnalyzer {
  analyze(input: {
    missionRevision: number;
    interpretation: SteeringInterpretation;
    workItems: WorkItem[];
    artifacts: Artifact[];
    changedRequirementRefs?: string[];
  }): SteeringImpact {
    const interpretation = input.interpretation;
    const affectedRequirements = new Set([
      ...interpretation.affectedRequirementRefs,
      ...(input.changedRequirementRefs ?? [])
    ]);
    const affectedWork = new Set(interpretation.affectedWorkItemRefs);
    const affectedArtifacts = new Set(interpretation.affectedArtifactRefs);

    if (interpretation.kind === "semantic") {
      for (const work of input.workItems) {
        if (work.requirementRefs.some(ref => affectedRequirements.has(ref))) affectedWork.add(work.id);
      }

      if (interpretation.strategyImpact === "global" && affectedWork.size === 0 && affectedArtifacts.size === 0) {
        for (const work of input.workItems) {
          if (!terminalWork(work.status)) affectedWork.add(work.id);
        }
        for (const artifact of input.artifacts) {
          if (artifact.status !== "superseded") affectedArtifacts.add(artifactRef(artifact));
        }
      }

      let changed = true;
      while (changed) {
        changed = false;
        const producedLogicalNames = new Set(
          input.workItems
            .filter(work => affectedWork.has(work.id))
            .flatMap(work => work.expectedOutputs.map(output => output.logicalName))
        );
        for (const artifact of input.artifacts) {
          const ref = artifactRef(artifact);
          if (affectedArtifacts.has(ref)) continue;
          if (producedLogicalNames.has(artifact.logicalName) || artifact.sourceArtifactRefs.some(source => affectedArtifacts.has(source))) {
            affectedArtifacts.add(ref);
            changed = true;
          }
        }
        for (const work of input.workItems) {
          if (affectedWork.has(work.id)) continue;
          const parentAffected = !!work.parentWorkItemId && affectedWork.has(work.parentWorkItemId);
          const artifactAffected = work.inputArtifactRefs.some(ref => affectedArtifacts.has(ref) || hasLogicalArtifact(affectedArtifacts, ref));
          if (parentAffected || artifactAffected) {
            affectedWork.add(work.id);
            changed = true;
          }
        }
      }

      if (
        interpretation.strategyImpact === "local" &&
        affectedWork.size === 0 &&
        affectedArtifacts.size === 0 &&
        (interpretation.specPatch || interpretation.revisedAcceptanceContract)
      ) {
        for (const work of input.workItems) if (!terminalWork(work.status)) affectedWork.add(work.id);
      }
    }

    const invalidatedWorkItemRefs = [...affectedWork].filter(id => {
      const work = input.workItems.find(candidate => candidate.id === id);
      return work && !["invalidated", "superseded", "abandoned"].includes(work.status);
    });
    const activeStatuses = new Set(["ready", "running", "waiting", "verifying", "blocked"]);
    const unaffectedActiveWorkItemRefs = input.workItems
      .filter(work => activeStatuses.has(work.status) && !affectedWork.has(work.id))
      .map(work => work.id);

    return {
      kind: interpretation.kind,
      reason: interpretation.reason,
      confidence: interpretation.confidence,
      previousMissionRevision: input.missionRevision,
      strategyImpact: interpretation.strategyImpact,
      affectedRequirementRefs: [...affectedRequirements],
      invalidatedWorkItemRefs,
      invalidatedArtifactRefs: [...affectedArtifacts],
      unaffectedActiveWorkItemRefs
    };
  }
}

function artifactRef(artifact: Artifact): string { return `${artifact.id}@${artifact.version}`; }
function hasLogicalArtifact(refs: Set<string>, ref: string): boolean {
  const id = ref.split("@")[0];
  for (const candidate of refs) if (candidate.split("@")[0] === id) return true;
  return false;
}
function terminalWork(status: WorkItem["status"]): boolean {
  return ["succeeded", "failed", "invalidated", "superseded", "abandoned"].includes(status);
}
