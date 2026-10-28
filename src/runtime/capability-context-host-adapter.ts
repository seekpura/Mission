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
import type { MissionAgentSkillWorkspaceProjector } from "./agent-skill-runtime.ts";

/**
 * Projects Mission-authorized acquired Agent Skills into the attempt-local
 * workspace before delegating to the real HostAdapter. DeepSeek Harness then
 * discovers `.agents/skills/<name>/SKILL.md` through its native filesystem skill
 * provider and exposes the normal model-facing skill catalog/loader.
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

  snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return this.base.snapshotEnvironment();
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
