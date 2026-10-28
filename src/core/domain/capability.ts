export type CapabilityKind = "skill" | "tool" | "mcp" | "agent" | "runtime" | "library" | "cli" | "application" | "workflow";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type CapabilityNeedStatus = "checking-installed" | "discovering" | "evaluating" | "acquiring" | "available" | "unresolved";

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  hostNative: boolean;
  available: boolean;
  invocationRef?: string;
  permissions: string[];
  revision?: string;
  contentHash?: string;
  sourceUri?: string;
  scope: "host" | "mission" | "trusted-cache";
  metadata?: Record<string, unknown>;
}

export interface CapabilityNeed {
  id: string;
  missionId: string;
  objective: string;
  requiredFunctions: string[];
  desiredInputs: string[];
  desiredOutputs: string[];
  purpose: "production" | "verification" | "research" | "integration";
  urgency: "blocking" | "high-value" | "optional-improvement";
  acquisitionAllowed: boolean;
  maxRisk: RiskLevel;
  requirementRefs: string[];
  gapRefs: string[];
  status?: CapabilityNeedStatus;
  resolvedCapabilityRef?: string;
  replacesCapabilityRef?: string;
}

export interface CapabilityCandidate {
  id: string;
  sourceType: "host" | "agent-skill" | "mcp-registry" | "github" | "npm" | "pypi" | "cargo" | "other";
  sourceUri: string;
  name: string;
  description?: string;
  candidateKind: CapabilityKind;
  resolvedRevision?: string;
  contentHash?: string;
  status: "discovered" | "inspecting" | "rejected" | "quarantined" | "verified" | "activated";
  metadata?: Record<string, unknown>;
}

export interface MaterializedCapabilityCandidate {
  candidate: CapabilityCandidate;
  root: string;
  resolvedRevision: string;
  contentHash: string;
}

export interface SecurityFinding {
  severity: RiskLevel;
  category: string;
  detail: string;
  file?: string;
}

export interface SecurityAssessment {
  candidateId: string;
  overall: RiskLevel;
  findings: SecurityFinding[];
  requestedPermissions: string[];
  recommendedAction: "sandbox" | "approval_required" | "reject";
}

export interface SandboxAssessment {
  candidateId: string;
  passed: boolean;
  mode: "instruction" | "node-cli" | "generic";
  observations: string[];
  invocationRef?: string;
  error?: string;
}

export interface AcquisitionReceipt {
  id: string;
  missionId: string;
  capabilityNeedRef: string;
  candidateId: string;
  sourceUri: string;
  resolvedRevision: string;
  contentHash: string;
  security: SecurityAssessment;
  sandbox: SandboxAssessment;
  capabilityRef?: string;
  status: "activated" | "rejected" | "approval_required" | "failed";
  createdAt: string;
}
