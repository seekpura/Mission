import type { Artifact } from "../domain/artifact.ts";
import type { InspectionRequest } from "../domain/inspection.ts";
import type { VerificationProfile } from "../domain/verification.ts";

export class InspectionPlanner {
  plan(artifact: Artifact, profile: VerificationProfile): InspectionRequest[] {
    const perceptual = profile.checks.filter(check => check.method === "perceptual");
    if (perceptual.length === 0) return [];
    const kind = kindForArtifact(artifact);
    if (!kind) return [];
    const requirementRefs = [...new Set(perceptual.flatMap(check => check.requirementRefs))].sort();
    return [{
      kind,
      artifactRef: `${artifact.id}@${artifact.version}`,
      reason: `Perceptual verification requires observable ${kind} output for ${artifact.type}`,
      requirementRefs
    }];
  }
}

function kindForArtifact(artifact: Artifact): InspectionRequest["kind"] | null {
  if (artifact.type === "presentation" || artifact.type === "document") return "page-render";
  if (artifact.type === "website") return "viewport-screenshot";
  if (artifact.type === "video") return "keyframe";
  return null;
}
