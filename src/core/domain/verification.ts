export interface FindingLocation {
  page?: number;
  slide?: number;
  timestampStart?: number;
  timestampEnd?: number;
  file?: string;
  selector?: string;
  region?: string;
}

export interface Finding {
  id: string;
  missionId: string;
  artifactRef?: string;
  category: "structural" | "functional" | "visual" | "content" | "technical" | "integration" | "evidence" | "constraint";
  severity: "critical" | "major" | "minor" | "advisory";
  location?: FindingLocation;
  observation: string;
  expected: string;
  requirementRefs: string[];
  evidenceRefs: string[];
  confidence: number;
  createdAt: string;
}

/**
 * Fine-grained evidence identity used by verification profiles. A verifier may
 * reason over evidence, but it does not get to invent one of these kinds: the
 * Runtime must have collected and durably registered the referenced Evidence.
 */
export type VerificationEvidenceKind =
  | "file-integrity"
  | "text-content"
  | "presentation-package"
  | "presentation-render"
  | "website-source"
  | "browser-runtime"
  | "accessibility-check"
  | "media-probe"
  | "media-playback"
  | "code-source"
  | "executable-test"
  | "build-check"
  | "integration-test"
  | "static-analysis"
  | "source-traceability"
  | "source-recency";

export interface Evidence {
  id: string;
  missionId: string;
  subjectRef: string;
  type: "test-result" | "render-inspection" | "source" | "runtime-check" | "human-approval" | "automated-review" | "file-validation";
  kind: VerificationEvidenceKind;
  claim: string;
  result: "supports" | "contradicts" | "inconclusive";
  collectorId: string;
  sourceRef?: string;
  producedBy?: string;
  /**
   * Bounded structured observations only. Artifact bodies, credentials and
   * opaque provider payloads must not be copied here merely for convenience.
   */
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface VerificationCheckResult {
  id: string;
  status: "pass" | "fail" | "warning" | "inconclusive";
  detail?: string;
  evidenceRefs: string[];
}

export interface GapAssessment {
  gapId: string;
  status: "resolved" | "still_open" | "inconclusive";
  detail?: string;
  evidenceRefs: string[];
  confidence: number;
}

export interface VerificationResult {
  id: string;
  missionId: string;
  artifactRef: string;
  verificationProfileId: string;
  verifierId: string;
  level: "structural" | "functional" | "quality" | "integration" | "mission";
  overall: "pass" | "pass_with_warnings" | "fail" | "inconclusive";
  checkResults: VerificationCheckResult[];
  findingRefs: string[];
  evidenceRefs: string[];
  gapAssessments?: GapAssessment[];
  createdAt: string;
}

export interface Gap {
  id: string;
  missionId: string;
  category: "missing_output" | "quality" | "fact" | "capability" | "runtime" | "integration" | "constraint" | "evidence";
  severity: "critical" | "major" | "minor";
  description: string;
  findingRefs: string[];
  requirementRefs: string[];
  artifactRefs: string[];
  status: "open" | "working" | "resolved" | "accepted" | "blocked";
  openedAt: string;
  resolvedAt?: string;
}
