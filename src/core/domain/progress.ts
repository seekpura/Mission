import type { RepairScope } from "../planning/deliberation-provider.ts";

export interface MissionProgressSnapshot {
  missionId: string;
  missionRevision: number;
  requiredSatisfied: number;
  requiredTotal: number;
  blockingGapRefs: string[];
  openGapRefs: string[];
  verifiedArtifactRefs: string[];
  finalArtifactRefs: string[];
  failedInvocationCount: number;
  repairWorkCount: number;
  signature: string;
  observedAt: string;
}

export interface PlateauContext {
  stagnationCount: number;
  priorRepairCount: number;
  priorRepairScopes: RepairScope[];
  highestRepairScope?: RepairScope;
  lastProgressAt?: string;
  waitingReason?: "approval" | "capability" | "execution" | "ready-work";
}

export interface PlateauAssessment {
  state: "progressing" | "waiting" | "stalled" | "plateau";
  reason: string;
  context: PlateauContext;
}
