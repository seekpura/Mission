
export type VerificationMethod = "deterministic" | "semantic" | "perceptual" | "runtime" | "source" | "human" | "integration";

export interface VerificationCheck {
  id: string;
  description: string;
  category: "structural" | "functional" | "content" | "visual" | "technical" | "integration" | "evidence" | "constraint";
  level: "structural" | "functional" | "quality" | "integration" | "mission";
  method: VerificationMethod;
  priority: "critical" | "required" | "preferred";
  requirementRefs: string[];
  config?: {
    runtime?: { command: string; args?: string[]; timeoutMs?: number; env?: Record<string, string> };
    integration?: { mode: "artifacts-present"; artifactLogicalNames: string[] };
  };
}

export interface VerificationProfile {
  id: string;
  artifactType: string;
  checks: VerificationCheck[];
}

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

export interface Evidence {
  id: string;
  missionId: string;
  subjectRef: string;
  type: "test-result" | "render-inspection" | "source" | "runtime-check" | "human-approval" | "automated-review" | "file-validation";
  claim: string;
  result: "supports" | "contradicts" | "inconclusive";
  sourceRef?: string;
  producedBy?: string;
  createdAt: string;
}

export interface VerificationCheckResult {
  id: string;
  status: "pass" | "fail" | "warning" | "inconclusive";
  detail?: string;
  evidenceRefs: string[];
  method?: VerificationMethod;
  priority?: "critical" | "required" | "preferred";
  category?: VerificationCheck["category"];
  requirementRefs?: string[];
  cacheKey?: string;
  reusedFromVerificationId?: string;
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
  cacheKey?: string;
  reusedCheckCount?: number;
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
