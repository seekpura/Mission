export type CapabilityKind = "skill" | "tool" | "mcp" | "agent" | "runtime" | "library" | "cli" | "application" | "workflow";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type CapabilityEnvironment = "shell" | "filesystem" | "browser";
export type CapabilityExecutionMode = "host-agent" | "host-capability" | "mission-context" | "local-process" | "remote-service" | "library";
export type CapabilityCostClass = "negligible" | "low" | "medium" | "high" | "unknown";
export type CapabilityLatencyClass = "local" | "interactive" | "batch" | "remote" | "unknown";

export interface CapabilityConstraints {
  requiredEnvironment?: CapabilityEnvironment[];
  requiresCapabilityRefs?: string[];
  supportedPurposes?: CapabilityNeed["purpose"][];
  maxConcurrency?: number;
}

export interface CapabilityRouting {
  executionMode: CapabilityExecutionMode;
  executorIds?: string[];
  resumable?: boolean;
  concurrent?: boolean;
  isolation?: "host" | "process" | "container" | "vm" | "remote" | "instruction-only" | "unknown";
}

export interface CapabilityCostProfile {
  monetaryClass?: CapabilityCostClass;
  latencyClass?: CapabilityLatencyClass;
  metered?: boolean;
}

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
  scope: "host" | "mission" | "trusted-cache";
  /** Explicit semantic functions are preferred over free-text name/description matching. */
  functions?: string[];
  /** Logical input classes the capability can consume. */
  accepts?: string[];
  /** Logical output classes the capability can produce. */
  produces?: string[];
  constraints?: CapabilityConstraints;
  routing?: CapabilityRouting;
  cost?: CapabilityCostProfile;
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
