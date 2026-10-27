export type ArtifactType = "file" | "document" | "presentation" | "image" | "video" | "audio" | "code" | "website" | "dataset" | "research" | "other";
export type ArtifactStatus = "working" | "candidate" | "verified" | "integrated" | "final" | "invalid" | "superseded";

export interface Artifact {
  id: string;
  missionId: string;
  logicalName: string;
  type: ArtifactType;
  version: number;
  status: ArtifactStatus;
  uri: string;
  contentHash: string;
  mimeType?: string;
  sizeBytes?: number;
  producedByAttemptId: string;
  sourceArtifactRefs: string[];
  createdAt: string;
}

export type ArtifactRelation = "derived_from" | "references" | "embeds" | "transforms" | "summarizes" | "validates" | "supersedes";

export interface ArtifactEdge {
  missionId: string;
  fromArtifactRef: string;
  toArtifactRef: string;
  relation: ArtifactRelation;
}
