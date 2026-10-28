import type { HostCapabilityGraph } from "../../core/capabilities/capability-graph.ts";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
import type { SideEffectPolicy } from "../../core/domain/execution.ts";

export interface HostDescriptor {
  type: string;
  version?: string;
  metadata?: Record<string, unknown>;
}

export interface EnvironmentSnapshot {
  revision: number;
  host: HostDescriptor;
  capabilities: CapabilityDescriptor[];
  /** Rich semantic graph for planners/resolvers. Optional for legacy host adapters. */
  capabilityGraph?: HostCapabilityGraph;
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

export interface HostMcpNameValue {
  name: string;
  value: string;
}

export type HostMcpServer =
  | {
      transport: "stdio";
      name: string;
      command: string;
      args: string[];
      env: HostMcpNameValue[];
    }
  | {
      transport: "http";
      name: string;
      url: string;
      headers: HostMcpNameValue[];
    };

export interface AgentCreateRequest {
  missionId: string;
  workItemId: string;
  /** Runtime identity is host-control metadata and is not authored by the Worker. */
  attemptId?: string;
  executionId?: string;
  context: unknown;
  allowedCapabilityRefs: string[];
  workspaceRoot?: string;
  /** Runtime-owned side-effect policy used by provider permission bridges. */
  sideEffectPolicy?: SideEffectPolicy;
  /** Provider-native MCP declarations selected by a trusted Host delivery layer. */
  mcpServers?: HostMcpServer[];
}

export interface AgentResumeRequest extends AgentCreateRequest {
  handleId: string;
  nativeRef: string;
}

export type HostAgentResumeResult =
  | { status: "resumed"; handle: HostAgentHandle }
  | { status: "unsupported" | "not_found" | "failed"; reason: string };

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
  resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult>;
  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void>;
  cancelAgent(handle: HostAgentHandle): Promise<void>;
  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent>;
  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult>;
  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}
