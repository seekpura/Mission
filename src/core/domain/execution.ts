import type { ArtifactExpectation } from "./work-item.ts";

export interface PermissionEnvelope {
  filesystemRead: string[];
  filesystemWrite: string[];
  network: "deny" | "allowlist" | "allow";
  networkHosts: string[];
  allowedEnvKeys: string[];
  subprocess: boolean;
  packageInstall: boolean;
  secrets: "deny" | "scoped";
  hostMutation: boolean;
}

export interface IsolationPolicy {
  level: "host" | "process" | "restricted" | "container" | "vm" | "remote";
  networkIsolation: boolean;
  filesystemIsolation: boolean;
  processIsolation: boolean;
  secretIsolation: boolean;
}

export interface WorkspacePolicy {
  type: "filesystem" | "git-worktree" | "application" | "browser" | "remote" | "hybrid";
  lifecycle: "ephemeral" | "mission" | "persistent";
}

export interface SideEffectPolicy {
  externalWrites: "deny" | "approval" | "allow";
  destructiveWrites: "deny" | "approval";
  irreversibleActions: "deny" | "approval";
  idempotencyRequired: boolean;
}

export interface ResourceRequest {
  cpu?: number;
  memoryMb?: number;
  gpu?: boolean;
  browserSessions?: number;
  applicationRefs?: string[];
  exclusiveResources?: string[];
}

export interface ExecutorRef {
  id: string;
  type: "host_agent" | "workflow" | "cli" | "tool" | "verifier";
}

export interface ExecutionRequest {
  executionId: string;
  missionId: string;
  workItemId: string;
  attemptId: string;
  executor: ExecutorRef;
  contextPacketId: string;
  inputArtifactRefs: string[];
  expectedOutputs: ArtifactExpectation[];
  capabilityRefs: string[];
  workspacePolicy: WorkspacePolicy;
  isolationPolicy: IsolationPolicy;
  permissionEnvelope: PermissionEnvelope;
  timeoutPolicy: { softTimeoutMs?: number; hardTimeoutMs?: number };
  retryPolicy: { runtimeRetries: number };
  sideEffectPolicy: SideEffectPolicy;
  resourceRequest?: ResourceRequest;
}

/**
 * Durable bridge between a Mission execution id and a host-native runtime.
 * It contains only identity/location data needed to reconnect after the
 * Mission process is replaced; task context remains reconstructable from the
 * Mission event stream.
 */
export interface ExecutionRuntimeBinding {
  executionId: string;
  attemptId: string;
  workItemId: string;
  driverId: string;
  routeId?: string;
  hostHandleId: string;
  nativeRef?: string;
  workspaceRoot: string;
  boundAt: string;
}

export interface ProducedFile {
  path: string;
  logicalName?: string;
  type?: string;
}

export interface SideEffectRecord {
  type: "filesystem" | "network" | "external-write" | "deployment" | "message" | "purchase" | "system-change";
  target: string;
  reversible: boolean;
  result: string;
}

export interface ExecutionResult {
  executionId: string;
  state: "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "lost";
  exitCode?: number;
  producedFiles: ProducedFile[];
  committedArtifactRefs: string[];
  runtimeObservationRef?: string;
  logRef?: string;
  sideEffects: SideEffectRecord[];
  startedAt: string;
  endedAt: string;
}
