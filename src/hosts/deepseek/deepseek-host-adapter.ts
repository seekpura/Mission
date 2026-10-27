import type {
  AgentCreateRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "./host-adapter.ts";

export interface DeepSeekBindings {
  describe(): Promise<HostDescriptor>;
  environment(): Promise<EnvironmentSnapshot>;
  createAgent(request: AgentCreateRequest): Promise<HostAgentHandle>;
  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void>;
  cancelAgent(handle: HostAgentHandle): Promise<void>;
  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent>;
  invokeCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult>;
  requestApproval(request: ApprovalRequest): Promise<ApprovalResult>;
}

export class DeepSeekHarnessAdapter implements HostAdapter {
  private readonly bindings: DeepSeekBindings;
  constructor(bindings: DeepSeekBindings) { this.bindings = bindings; }
  describeHost() { return this.bindings.describe(); }
  snapshotEnvironment() { return this.bindings.environment(); }
  createAgent(request: AgentCreateRequest) { return this.bindings.createAgent(request); }
  steerAgent(handle: HostAgentHandle, delta: ContextDelta) { return this.bindings.steerAgent(handle, delta); }
  cancelAgent(handle: HostAgentHandle) { return this.bindings.cancelAgent(handle); }
  observeAgent(handle: HostAgentHandle) { return this.bindings.observeAgent(handle); }
  invokeHostCapability(request: HostCapabilityInvocation) { return this.bindings.invokeCapability(request); }
  requestUserApproval(request: ApprovalRequest) { return this.bindings.requestApproval(request); }
}
