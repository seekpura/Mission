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
} from "../hosts/deepseek/host-adapter.ts";
import type { MissionAgentSkillContextResolver } from "./agent-skill-runtime.ts";

export class CapabilityContextHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly skills: MissionAgentSkillContextResolver;

  constructor(base: HostAdapter, skills: MissionAgentSkillContextResolver) {
    this.base = base;
    this.skills = skills;
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return this.base.snapshotEnvironment();
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    return this.base.createAgent(await this.withCapabilityContext(request));
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return this.base.resumeAgent(await this.withCapabilityContext(request));
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

  private async withCapabilityContext<T extends AgentCreateRequest | AgentResumeRequest>(request: T): Promise<T> {
    const contexts = this.skills.resolve(request.missionId, request.allowedCapabilityRefs);
    if (contexts.length === 0) return request;
    return {
      ...request,
      context: mergeContext(request.context, contexts)
    } as T;
  }
}

function mergeContext(base: unknown, capabilities: ReturnType<MissionAgentSkillContextResolver["resolve"]>) {
  if (base && typeof base === "object" && !Array.isArray(base)) {
    return {
      ...(base as Record<string, unknown>),
      missionCapabilityContext: capabilities.map(capability => ({
        id: capability.id,
        name: capability.name,
        ...(capability.revision ? { revision: capability.revision } : {}),
        contentHash: capability.contentHash,
        type: "agent-skill-instructions",
        instructions: capability.instructions
      }))
    };
  }
  return {
    baseContext: base,
    missionCapabilityContext: capabilities.map(capability => ({
      id: capability.id,
      name: capability.name,
      ...(capability.revision ? { revision: capability.revision } : {}),
      contentHash: capability.contentHash,
      type: "agent-skill-instructions",
      instructions: capability.instructions
    }))
  };
}
