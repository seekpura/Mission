export type SourceType = "web" | "file" | "github" | "document" | "api" | "user" | "other";
export type SourceStatus = "active" | "stale" | "superseded" | "unavailable";

export interface SourceRecord {
  id: string;
  missionId: string;
  type: SourceType;
  uri?: string;
  localRef?: string;
  title?: string;
  capturedAt: string;
  version?: string;
  commit?: string;
  authority?: string;
  freshUntil?: string;
  contentHash?: string;
  status: SourceStatus;
  supersededBy?: string;
  metadata: Record<string, unknown>;
}

export type TruthStatus = "active" | "stale" | "superseded" | "disputed" | "invalidated";
export type TruthConfidence = "explicit" | "verified" | "derived" | "assumed";

export interface TruthRecord {
  id: string;
  missionId: string;
  key: string;
  value: unknown;
  source: "user" | "source" | "artifact" | "inference" | "decision";
  sourceRefs: string[];
  confidence: TruthConfidence;
  status: TruthStatus;
  requirementRefs: string[];
  artifactRefs: string[];
  createdAt: string;
  supersededBy?: string;
}
