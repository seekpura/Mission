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

/**
 * Provider model/reasoning settings that the current Runtime adapter can
 * truthfully preserve. A configured override is not the same thing as a live
 * provider model catalog: catalogValidated remains false until an adapter
 * actually performs provider-native discovery/validation.
 */
export interface CapabilityNativeModelSemantics {
  configuredModel?: string;
  configuredReasoningEffort?: string;
  catalogValidated?: boolean;
  providerMultiAgentVersion?: "disabled" | "v1" | "v2";
}

/**
 * Coordination controls are deliberately explicit about Runtime authority.
 * Provider/model metadata alone must not be interpreted as Mission being able
 * to spawn, route or observe subagents/teams.
 */
export interface CapabilityNativeCoordinationSemantics {
  runtimeManagedSubagents: boolean;
  runtimeManagedTeams: boolean;
  delegatedTurns: boolean;
}

/** Provider-native background/job lifecycle that Mission can actually control. */
export interface CapabilityNativeJobSemantics {
  background: boolean;
  durable: boolean;
  observable: boolean;
  cancellable: boolean;
}

export interface CapabilityNativeSemantics {
  provider?: string;
  nativeId?: string;
  protocol?: string;
  loadMode?: "preinstalled" | "dynamic" | "mission-overlay" | "remote" | "unknown";
  approvalModes?: Array<"none" | "once" | "mission" | "revision" | "host" | "provider-native">;
  features?: string[];
  persistence?: Array<"session" | "resume" | "recovery" | "background-job" | "durable-state">;
  model?: CapabilityNativeModelSemantics;
  coordination?: CapabilityNativeCoordinationSemantics;
  jobs?: CapabilityNativeJobSemantics;
}

export interface CapabilityProvenance {
  source: "host" | "mission" | "trusted-cache" | "external";
  sourceRef?: string;
  revision?: string;
  contentHash?: string;
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
  /** Provider-native identity and behavior that Mission must preserve instead of flattening across harnesses. */
  native?: CapabilityNativeSemantics;
  provenance?: CapabilityProvenance;
}

/**
 * Optional hard policy declared for a CapabilityNeed. These fields do not
 * select a capability by themselves; they constrain the live host capability
 * graph before semantic scoring. Omitted fields preserve legacy behavior.
 */
export interface CapabilityNeedPolicy {
  acceptableKinds?: CapabilityKind[];
  requiredExecutionModes?: CapabilityExecutionMode[];
  forbiddenPermissions?: string[];
  acceptableProviders?: string[];
  requiredNativeFeatures?: string[];
  acceptableProvenanceSources?: CapabilityProvenance["source"][];
  maxMonetaryClass?: Exclude<CapabilityCostClass, "unknown">;
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
  policy?: CapabilityNeedPolicy;
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
