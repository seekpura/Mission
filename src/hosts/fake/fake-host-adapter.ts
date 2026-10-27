import { randomUUID } from "node:crypto";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
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
} from "../deepseek/host-adapter.ts";

export interface FakeHostOptions {
  agentResponder?: (request: AgentCreateRequest) => unknown | Promise<unknown>;
  capabilityInvoker?: (request: HostCapabilityInvocation) => HostCapabilityResult | Promise<HostCapabilityResult>;
}

export class FakeHostAdapter implements HostAdapter {
  readonly capabilities: CapabilityDescriptor[];
  private readonly options: FakeHostOptions;
  private readonly requests = new Map<string, AgentCreateRequest>();

  constructor(capabilities: CapabilityDescriptor[] = [], options: FakeHostOptions = {}) {
    this.capabilities = capabilities;
    this.options = options;
  }
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
  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const handle = { id: randomUUID() };
    this.requests.set(handle.id, request);
    return handle;
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(handle: HostAgentHandle): Promise<void> { this.requests.delete(handle.id); }
  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const request = this.requests.get(handle.id);
    if (!request) throw new Error(`Unknown fake agent: ${handle.id}`);
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    try {
      const payload = this.options.agentResponder ? await this.options.agentResponder(request) : {};
      yield { type: "completed", payload, at: new Date().toISOString() };
    } catch (error) {
      yield { type: "failed", payload: { error: error instanceof Error ? error.message : String(error) }, at: new Date().toISOString() };
    } finally {
      this.requests.delete(handle.id);
    }
  }
  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.options.capabilityInvoker ? this.options.capabilityInvoker(request) : { ok: true, output: {} };
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: true, scope: "once" }; }
}
