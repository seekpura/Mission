export type WorkPurpose = "exploration" | "production" | "verification" | "repair" | "acquisition" | "integration";
export type WorkStatus = "proposed" | "ready" | "running" | "waiting" | "verifying" | "succeeded" | "failed" | "blocked" | "invalidated" | "superseded" | "abandoned";

export interface ArtifactExpectation {
  logicalName: string;
  type: string;
  required: boolean;
  path?: string;
}

export interface ArtifactDependency {
  logicalName: string;
  type?: string;
  minimumStatus?: "candidate" | "verified" | "final";
}

export interface LocalAcceptanceCriterion {
  id: string;
  description: string;
  priority: "critical" | "required" | "preferred";
}

export interface WorkExecutionConstraints {
  excludeCapabilityRefs?: string[];
  preferredCapabilityNeedRefs?: string[];
  excludeExecutorRefs?: string[];
  avoidRouteKinds?: Array<"host_agent" | "host_capability" | "local_cli">;
  forceFreshAgent?: boolean;
  sourceDecisionReason?: string;
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
  artifactDependencies?: ArtifactDependency[];
  expectedOutputs: ArtifactExpectation[];
  localAcceptanceCriteria: LocalAcceptanceCriterion[];
  capabilityNeedRefs: string[];
  executionConstraints?: WorkExecutionConstraints;
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
