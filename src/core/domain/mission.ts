export type MissionStatus =
  | "created"
  | "interpreting"
  | "active"
  | "waiting_approval"
  | "waiting_external"
  | "blocked"
  | "plateau"
  | "completed"
  | "reopened"
  | "cancelled"
  | "failed";

export interface MissionSpec {
  missionId: string;
  revision: number;
  objective: string;
  intent?: string;
  requestedOutputs: string[];
  constraints: string[];
  preferences: string[];
  sourceRefs: string[];
  createdAt: string;
}

export interface Requirement {
  id: string;
  description: string;
  type: "functional" | "content" | "visual" | "technical" | "evidence" | "experience" | "compliance";
  priority: "critical" | "required" | "preferred";
  verification: "artifact" | "test" | "review" | "evidence" | "runtime" | "human";
  status: "unverified" | "satisfied" | "failed" | "blocked";
  evidenceRefs: string[];
}

export interface RequiredArtifact {
  logicalName: string;
  type?: string;
  description?: string;
  requirementRefs: string[];
}

export interface RequiredValidation {
  id: string;
  description: string;
  level?: "structural" | "functional" | "quality" | "integration" | "mission";
  requirementRefs: string[];
}

export interface AcceptanceContract {
  missionId: string;
  revision: number;
  requirements: Requirement[];
  requiredArtifacts: RequiredArtifact[];
  requiredValidations: RequiredValidation[];
  criticalFailureConditions: string[];
  completionPolicy?: {
    requireAllCritical?: boolean;
    requireAllRequired?: boolean;
    allowPreferredOpen?: boolean;
  };
  createdAt: string;
}

export interface MissionState {
  missionId: string;
  status: MissionStatus;
  revision: number;
  missionSpecRevision: number;
  acceptanceRevision: number;
  strategyRevision: number | null;
  graphRevision: number;
  environmentSnapshotRevision: number;
  activeWorkstreamIds: string[];
  activeWorkItemIds: string[];
  readyWorkItemIds: string[];
  blockedWorkItemIds: string[];
  verifyingWorkItemIds: string[];
  openGapIds: string[];
  blockingGapIds: string[];
  activeExecutionIds: string[];
  pendingApprovalIds: string[];
  finalArtifactRefs: string[];
  lastEventSequence: number;
  createdAt?: string;
  updatedAt?: string;
}
