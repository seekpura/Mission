export type CostCategory = "wall_time" | "external_side_effect" | "api" | "compute" | "storage" | "unknown";

export interface CostEvent {
  id: string;
  missionId: string;
  workItemId?: string;
  attemptId?: string;
  executionId?: string;
  category: CostCategory;
  quantity: number;
  unit: string;
  monetaryEstimate?: number;
  source: string;
  createdAt: string;
}

export interface AuditRecord {
  id: string;
  missionId: string;
  action: string;
  actorType: string;
  actorId?: string;
  target?: string;
  authorizationRefs: string[];
  evidenceRefs: string[];
  data: Record<string, unknown>;
  createdAt: string;
}

export interface CompletionRecord {
  missionId: string;
  missionRevision: number;
  completedAt: string;
  finalArtifactRefs: string[];
  criticalRequirementsSatisfied: number;
  criticalRequirementsTotal: number;
  requiredRequirementsSatisfied: number;
  requiredRequirementsTotal: number;
  blockingGapRefs: string[];
  verificationCount: number;
  totalObservedWallTimeMs: number;
  unresolvedAdvisories: string[];
  completionEventRef: string;
}

export interface CapabilityTrustProfile {
  missionId: string;
  capabilityId: string;
  purpose: string;
  attempts: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  successRate: number;
  averageWallTimeMs?: number;
  lastObservedAt: string;
}
