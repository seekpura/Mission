import type {
  CapabilityCostClass,
  CapabilityLatencyClass,
  CapabilityProvenance,
  RiskLevel
} from "./capability.ts";

export type CapabilityTrustLevel =
  | "host-native"
  | "mission-verified"
  | "trusted-cache"
  | "external-unverified"
  | "revoked";

export interface CapabilitySourceIdentity {
  sourceUri: string;
  sourceType: string;
  resolvedRevision: string;
  contentHash: string;
}

export interface CapabilityTrustRecord {
  id: string;
  missionId: string;
  capabilityNeedId: string;
  capabilityId: string;
  trustLevel: CapabilityTrustLevel;
  provenanceSource: CapabilityProvenance["source"] | "unknown";
  identity?: CapabilitySourceIdentity;
  securityRisk?: RiskLevel;
  acquisitionReceiptId?: string;
  cacheKey?: string;
  reusable: boolean;
  reason: string;
  recordedAt: string;
}

export interface CapabilityCostRecord {
  id: string;
  missionId: string;
  capabilityNeedId: string;
  capabilityId: string;
  phase: "resolution" | "acquisition" | "activation";
  monetaryClass: CapabilityCostClass;
  latencyClass: CapabilityLatencyClass;
  metered?: boolean;
  source: "capability-declared" | "runtime-observed" | "unknown";
  /**
   * Monetary amount is intentionally optional. Runtime must never invent a
   * numeric price from a cost class. Populate only when a provider returns a
   * concrete observed amount and currency.
   */
  amount?: number;
  currency?: string;
  recordedAt: string;
}

export type CapabilityAuditDecision =
  | "existing-resolved"
  | "acquired"
  | "trusted-cache-reused"
  | "deactivated"
  | "revoked"
  | "rejected";

export interface CapabilityAuditRecord {
  id: string;
  missionId: string;
  capabilityNeedId?: string;
  capabilityId?: string;
  candidateId?: string;
  decision: CapabilityAuditDecision;
  resolutionSource: "host-or-overlay" | "acquired" | "trusted-cache" | "none";
  trustRecordId?: string;
  costRecordId?: string;
  acquisitionReceiptId?: string;
  cacheKey?: string;
  reason: string;
  attempts: Array<{
    candidateId: string;
    candidateName: string;
    ok: boolean;
    reason?: string;
  }>;
  recordedAt: string;
}
