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
