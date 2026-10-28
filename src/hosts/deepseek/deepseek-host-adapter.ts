import { buildHostCapabilityGraph } from "../../core/capabilities/capability-graph.ts";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "./host-adapter.ts";

export interface DeepSeekBindings {
  describe(): Promise<HostDescriptor>;
  environment(): Promise<EnvironmentSnapshot>;
  createAgent(request: AgentCreateRequest): Promise<HostAgentHandle>;
  resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult>;
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
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const snapshot = await this.bindings.environment();
    const capabilities = snapshot.capabilities.map(capability => {
      if (capability.id !== "deepseek-harness.acp-agent") return capability;
      return {
        ...capability,
        functions: capability.functions ?? [
          "create agent session",
          "resume agent session",
          "execute mission work",
          "observe agent execution",
          "produce workspace artifacts"
        ],
        accepts: capability.accepts ?? ["mission context", "work item", "workspace", "capability instructions"],
        produces: capability.produces ?? ["artifact", "execution evidence", "agent events"],
        constraints: capability.constraints ?? {
          supportedPurposes: ["production", "verification", "research", "integration"]
        },
        routing: capability.routing ?? {
          executionMode: "host-agent",
          resumable: true,
          concurrent: true,
          isolation: "host"
        },
        cost: capability.cost ?? {
          monetaryClass: "unknown",
          latencyClass: "interactive",
          metered: true
        },
        native: capability.native ?? {
          provider: "deepseek-harness",
          nativeId: "acp-agent",
          protocol: "acp-v1",
          loadMode: "preinstalled",
          approvalModes: ["once", "provider-native"],
          features: ["create-session", "resume-session", "steer", "cancel", "observe-events", "workspace-context"],
          persistence: ["session", "resume", "recovery"]
        },
        provenance: capability.provenance ?? {
          source: "host",
          sourceRef: "dsh --profile acp"
        }
      };
    });
    const capabilityGraph = buildHostCapabilityGraph({
      revision: snapshot.revision,
      host: snapshot.host,
      capabilities,
      shellAvailable: snapshot.shellAvailable,
      filesystemAvailable: snapshot.filesystemAvailable,
      browserAvailable: snapshot.browserAvailable
    });
    return { ...snapshot, capabilities, capabilityGraph };
  }
  createAgent(request: AgentCreateRequest) { return this.bindings.createAgent(request); }
  resumeAgent(request: AgentResumeRequest) { return this.bindings.resumeAgent(request); }
  steerAgent(handle: HostAgentHandle, delta: ContextDelta) { return this.bindings.steerAgent(handle, delta); }
  cancelAgent(handle: HostAgentHandle) { return this.bindings.cancelAgent(handle); }
  observeAgent(handle: HostAgentHandle) { return this.bindings.observeAgent(handle); }
  invokeHostCapability(request: HostCapabilityInvocation) { return this.bindings.invokeCapability(request); }
  requestUserApproval(request: ApprovalRequest) { return this.bindings.requestApproval(request); }
}
