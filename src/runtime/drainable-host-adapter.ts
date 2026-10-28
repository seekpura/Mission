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

export interface DrainableHostSnapshot {
  draining: boolean;
  activeHandleIds: string[];
}

/**
 * Runtime-owned lifecycle wrapper for every provider HostAdapter. It does not
 * invent provider shutdown semantics: it stops admission of new native agent
 * sessions, tracks sessions already admitted through Mission Runtime, and uses
 * the ordinary provider cancel boundary when a bounded shutdown must force
 * those sessions to settle.
 */
export class DrainableHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly active = new Map<string, HostAgentHandle>();
  private readonly idleWaiters = new Set<() => void>();
  private draining = false;

  constructor(base: HostAdapter) {
    this.base = base;
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return this.base.snapshotEnvironment();
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.assertAccepting();
    const handle = await this.base.createAgent(request);
    this.track(handle);
    return handle;
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    this.assertAccepting();
    const result = await this.base.resumeAgent(request);
    if (result.status === "resumed") this.track(result.handle);
    return result;
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    await this.base.cancelAgent(handle);
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    try {
      for await (const event of this.base.observeAgent(handle)) {
        yield event;
        if (event.type === "completed" || event.type === "failed") return;
      }
    } finally {
      this.release(handle.id);
    }
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    if (this.draining) {
      return Promise.resolve({ ok: false, error: "Mission Runtime host is draining" });
    }
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }

  beginDrain(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }

  activeCount(): number {
    return this.active.size;
  }

  snapshot(): DrainableHostSnapshot {
    return {
      draining: this.draining,
      activeHandleIds: [...this.active.keys()].sort()
    };
  }

  async waitForIdle(): Promise<void> {
    if (this.active.size === 0) return;
    await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  async cancelActive(): Promise<{ attempted: string[]; failures: Array<{ handleId: string; error: string }> }> {
    this.beginDrain();
    const handles = [...this.active.values()];
    const failures: Array<{ handleId: string; error: string }> = [];
    await Promise.all(handles.map(async handle => {
      try {
        await this.base.cancelAgent(handle);
      } catch (error) {
        failures.push({
          handleId: handle.id,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }));
    return { attempted: handles.map(handle => handle.id), failures };
  }

  closeIfIdle(): void {
    this.beginDrain();
    if (this.active.size > 0) {
      throw new Error(`Cannot close HostAdapter with ${this.active.size} active Mission session(s)`);
    }
  }

  private assertAccepting(): void {
    if (this.draining) throw new Error("Mission Runtime host is draining and cannot create or resume agent sessions");
  }

  private track(handle: HostAgentHandle): void {
    const existing = this.active.get(handle.id);
    if (existing && existing.nativeRef !== handle.nativeRef) {
      throw new Error(`Host reused active handle id ${handle.id} for a different native session`);
    }
    this.active.set(handle.id, handle);
  }

  private release(handleId: string): void {
    if (!this.active.delete(handleId)) return;
    if (this.active.size !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
