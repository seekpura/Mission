import { randomUUID } from "node:crypto";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
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
} from "../host-adapter.ts";

export class FakeHostAdapter implements HostAdapter {
  readonly capabilities: CapabilityDescriptor[];
  constructor(capabilities: CapabilityDescriptor[] = []) { this.capabilities = capabilities; }
  async describeHost(): Promise<HostDescriptor> { return { type: "fake-host", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: this.capabilities,
      shellAvailable: true,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { return { id: randomUUID() }; }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "FakeHostAdapter does not model durable native sessions" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    yield { type: "completed", payload: {}, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: true, output: {} }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: true, scope: "once" }; }
}
