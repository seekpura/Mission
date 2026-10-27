export type DecisionType =
  | "continue"
  | "dispatch"
  | "spawn"
  | "retry"
  | "add_work"
  | "revise_work"
  | "invalidate_work"
  | "acquire_capability"
  | "replace_capability"
  | "replan_local"
  | "revise_strategy"
  | "request_approval"
  | "complete"
  | "block";

export interface MissionDecision {
  id: string;
  missionId: string;
  type: DecisionType;
  targetRefs: string[];
  rationale: string;
  evidenceRefs: string[];
  gapRefs: string[];
  requirementRefs: string[];
  expectedImpact?: string;
  confidence?: number;
  requiresApproval: boolean;
  status: "proposed" | "approved" | "applied" | "rejected" | "obsolete";
  createdAt: string;
}

export interface Approval {
  id: string;
  missionId: string;
  requestedAction: string;
  scope: "once" | "mission" | "revision" | "host";
  constraints: string[];
  status: "requested" | "approved" | "rejected" | "expired";
  requestedAt: string;
  decidedAt?: string;
}
