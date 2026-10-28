export type WorkPurpose = "exploration" | "production" | "verification" | "repair" | "acquisition" | "integration";
export type WorkStatus = "proposed" | "ready" | "running" | "waiting" | "verifying" | "succeeded" | "failed" | "blocked" | "invalidated" | "superseded" | "abandoned";

export interface ArtifactExpectation {
  logicalName: string;
  type: string;
  required: boolean;
}

export interface LocalAcceptanceCriterion {
  id: string;
  description: string;
  priority: "critical" | "required" | "preferred";
}

export interface WorkItem {
  id: string;
  missionId: string;
  workstreamId?: string;
  parentWorkItemId?: string;
  purpose: WorkPurpose;
  objective: string;
  status: WorkStatus;
  requirementRefs: string[];
  gapRefs: string[];
  inputArtifactRefs: string[];
  expectedOutputs: ArtifactExpectation[];
  localAcceptanceCriteria: LocalAcceptanceCriterion[];
  capabilityNeedRefs: string[];
  /**
   * Explicit planner-authored replacement relation. The controller validates
   * every ref against durable Mission Work before admission and emits a
   * `work.superseded` event only after the replacement Work itself is admitted.
   * This prevents completion from being permanently blocked by obsolete Work
   * while avoiding heuristic retirement based on gap-id naming conventions.
   */
  supersedesWorkItemRefs?: string[];
  assignedExecutorId?: string;
  priority: number;
  graphRevision: number;
  createdBy: "planner" | "replanner" | "worker" | "verifier" | "user" | "system";
  createdAt: string;
  updatedAt: string;
}

export interface Attempt {
  id: string;
  missionId: string;
  workItemId: string;
  sequence: number;
  executorId: string;
  capabilityRefs: string[];
  contextPacketId: string;
  status: "created" | "running" | "succeeded" | "partial" | "failed" | "cancelled";
  failureCategory?: string;
  executionIds: string[];
  artifactRefs: string[];
  startedAt?: string;
  endedAt?: string;
}
