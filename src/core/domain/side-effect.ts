export type SideEffectRisk =
  | "external-write"
  | "destructive"
  | "irreversible"
  | "unknown-external";

export type SideEffectDecision = "approval-required" | "denied" | "approved";
export type SideEffectOutcome = "pending" | "succeeded" | "failed" | "unknown";

export interface SideEffectIntent {
  id: string;
  missionId: string;
  workItemId: string;
  executionId?: string;
  attemptId?: string;
  hostHandleId?: string;
  toolCallId: string;
  toolKind: string;
  title: string;
  targetHint?: string;
  inputFingerprint: string;
  risk: SideEffectRisk;
  reversible: boolean;
  providerIdempotencyHash?: string;
  retrySafe: boolean;
  decision: SideEffectDecision;
  outcome: SideEffectOutcome;
  createdAt: string;
  decidedAt?: string;
  observedAt?: string;
}

export interface SideEffectOutcomeEvidence {
  intentId: string;
  missionId: string;
  workItemId: string;
  executionId?: string;
  toolCallId: string;
  outcome: Exclude<SideEffectOutcome, "pending">;
  detail?: string;
  observedAt: string;
}

export interface RuntimeSideEffectPolicy {
  externalWrites: "deny" | "approval";
  destructiveWrites: "deny" | "approval";
  irreversibleActions: "deny" | "approval";
  unknownExternalActions: "deny" | "approval";
  idempotencyRequiredForAutomaticRetry: boolean;
}

export const DEFAULT_RUNTIME_SIDE_EFFECT_POLICY: RuntimeSideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "deny",
  unknownExternalActions: "approval",
  idempotencyRequiredForAutomaticRetry: true
};
