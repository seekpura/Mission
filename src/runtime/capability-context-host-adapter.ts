import { buildHostCapabilityGraph } from "../core/capabilities/capability-graph.ts";
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
} from "../hosts/host-adapter.ts";
import type { MissionAgentSkillWorkspaceProjector } from "./agent-skill-runtime.ts";

/**
 * Projects Mission-authorized acquired Agent Skills into an attempt-local
 * workspace before delegating to a HostAdapter whose native skill loader is
 * explicitly compatible with this workspace projection. Production bootstrap
 * currently applies this delivery layer to DeepSeek Harness; other hosts must
 * opt in only after their provider-native loading semantics are verified.
 *
 * This outer delivery adapter is also an environment-snapshot boundary. Any
 * inner wrapper (for example trusted MCP delivery) may extend the flat host
 * catalog, so the semantic graph is rebuilt here from the final effective
 * catalog instead of forwarding a stale graph produced by an inner adapter.
 */
export class CapabilityWorkspaceHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly skills: MissionAgentSkillWorkspaceProjector;

  constructor(base: HostAdapter, skills: MissionAgentSkillWorkspaceProjector) {
    this.base = base;
    this.skills = skills;
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const snapshot = await this.base.snapshotEnvironment();
    return {
      ...snapshot,
      capabilityGraph: buildHostCapabilityGraph({
        revision: snapshot.revision,
        host: snapshot.host,
        capabilities: snapshot.capabilities,
        shellAvailable: snapshot.shellAvailable,
        filesystemAvailable: snapshot.filesystemAvailable,
        browserAvailable: snapshot.browserAvailable
      })
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.projectCapabilities(request);
    return this.base.createAgent(request);
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    this.projectCapabilities(request);
    return this.base.resumeAgent(request);
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  cancelAgent(handle: HostAgentHandle): Promise<void> {
    return this.base.cancelAgent(handle);
  }

  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    return this.base.observeAgent(handle);
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }

  private projectCapabilities(request: AgentCreateRequest | AgentResumeRequest): void {
    if (!request.workspaceRoot) {
      if (request.allowedCapabilityRefs.some(ref => ref.startsWith("acquired:"))) {
        throw new Error("Mission-local acquired capabilities require an explicit Host workspaceRoot");
      }
      return;
    }
    this.skills.project(request.missionId, request.allowedCapabilityRefs, request.workspaceRoot);
  }
}

/** @deprecated Use CapabilityWorkspaceHostAdapter. */
export class CapabilityContextHostAdapter extends CapabilityWorkspaceHostAdapter {}
