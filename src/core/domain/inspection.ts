import type { Artifact, ArtifactType } from "./artifact.ts";

export type InspectionKind = "page-render" | "viewport-screenshot" | "keyframe" | "metadata";

export interface InspectionRequest {
  kind: InspectionKind;
  artifactRef: string;
  reason: string;
  requirementRefs: string[];
}

export interface InspectionProduct {
  kind: InspectionKind;
  path: string;
  type: ArtifactType;
  logicalSuffix?: string;
  mimeType?: string;
}

export interface InspectionBundle {
  providerId: string;
  providerVersion?: string;
  sourceArtifactRef: string;
  products: InspectionProduct[];
}

export interface InspectionContext {
  outputDir: string;
  missionArtifacts: Artifact[];
}

export interface InspectionOutcome {
  required: boolean;
  requests: InspectionRequest[];
  artifacts: Artifact[];
  missingKinds: InspectionKind[];
}
