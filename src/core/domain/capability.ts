export type CapabilityKind = "skill" | "tool" | "mcp" | "agent" | "runtime" | "library" | "cli" | "application" | "workflow";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type CapabilityPurpose = "production" | "verification" | "research" | "integration";
export type CapabilityDeliveryMode =
  | "host-agent-session"
  | "workspace-skill"
  | "acp-mcp-stdio"
  | "acp-mcp-http"
  | "local-command"
  | "library"
  | "application"
  | "workflow"
  | "unknown";
export type CapabilityIsolationLevel = "none" | "host" | "process" | "restricted" | "container" | "vm" | "remote" | "unknown";
export type CapabilityNetworkAccess = "none" | "local" | "outbound" | "remote-service" | "unknown";
export type CapabilitySideEffectLevel = "none" | "read" | "write" | "external" | "unknown";
export type CapabilityTrustLevel = "host-native" | "operator-trusted" | "mission-acquired" | "trusted-cache" | "unknown";
export type CapabilityCostClass = "free" | "low" | "medium" | "high" | "unknown";

export interface CapabilitySemantics {
  /** Concrete functions this capability is expected to provide. */
  functions: string[];
  inputTypes: string[];
  outputTypes: string[];
  purposes: CapabilityPurpose[];
  deliveryModes: CapabilityDeliveryMode[];
  isolation: CapabilityIsolationLevel;
  networkAccess: CapabilityNetworkAccess;
  sideEffectLevel: CapabilitySideEffectLevel;
  trust: CapabilityTrustLevel;
  costClass: CapabilityCostClass;
  /** Other capability ids that must be present for this capability to be usable. */
  requiresCapabilityRefs?: string[];
  /** Provider-native identifiers that are safe to expose in capability metadata. */
  nativeRefs?: string[];
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
  semantics?: CapabilitySemantics;
}

export interface CapabilityNeed {
  id: string;
  missionId: string;
  objective: string;
  requiredFunctions: string[];
  desiredInputs: string[];
  desiredOutputs: string[];
  purpose: CapabilityPurpose;
  urgency: "blocking" | "high-value" | "optional-improvement";
  acquisitionAllowed: boolean;
  maxRisk: RiskLevel;
  /** Optional hard constraints. An omitted field means Runtime may choose any compatible value. */
  acceptableKinds?: CapabilityKind[];
  requiredDeliveryModes?: CapabilityDeliveryMode[];
  forbiddenPermissions?: string[];
  acceptableTrust?: CapabilityTrustLevel[];
  maxCostClass?: Exclude<CapabilityCostClass, "unknown">;
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
