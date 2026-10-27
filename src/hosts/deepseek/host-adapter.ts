import type { CapabilityDescriptor } from "../../core/domain/capability.ts";

export interface HostDescriptor {
  type: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface EnvironmentSnapshot {
  revision: number;
  host: HostDescriptor;
  capabilities: CapabilityDescriptor[];
  shellAvailable: boolean;
  filesystemAvailable: boolean;
  browserAvailable: boolean;
  capturedAt: string;
}

export interface ContextDelta {
  addedConstraintRefs?: string[];
  removedConstraintRefs?: string[];
  changedTruthRefs?: string[];
  message?: string;
}

export interface HostAgentHandle {
  id: string;
  nativeRef?: string;
}

export interface AgentCreateRequest {
  missionId: string;
  workItemId: string;
  context: unknown;
  allowedCapabilityRefs: string[];
  workspaceRoot?: string;
}

export interface HostAgentEvent {
  type: "started" | "message" | "tool" | "artifact" | "completed" | "failed";
  payload: unknown;
  at: string;
}

export interface HostCapabilityInvocation {
  capabilityId: string;
  input: unknown;
}

export interface HostCapabilityResult {
  ok: boolean;
  output?: unknown;
  error?: string;
}

export interface ApprovalRequest {
  missionId: string;
  title: string;
  reason: string;
  details?: Record<string, unknown>;
}

export interface ApprovalResult {
  approved: boolean;
  scope?: "once" | "mission" | "revision" | "host";
}

export interface HostAdapter {
  describeHost(): Promise<HostDescriptor>;
  snapshotEnvironment(): Promise<EnvironmentSnapshot>;
  createAgent(request: AgentCreateRequest): Promise<HostAgentHandle>;
  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void>;
  cancelAgent(handle: HostAgentHandle): Promise<void>;
  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent>;
  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult>;
  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
