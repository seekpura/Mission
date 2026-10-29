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
  admissionsInFlight: number;
}

/**
 * Runtime-owned lifecycle wrapper for every provider HostAdapter. It does not
 * invent provider shutdown semantics: it stops admission of new native agent
 * sessions, tracks both in-flight admissions and sessions already admitted
 * through Mission Runtime, and uses the ordinary provider cancel boundary when
 * a bounded shutdown must force those sessions to settle.
 */
export class DrainableHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly active = new Map<string, HostAgentHandle>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly cancellationTasks = new Map<string, Promise<void>>();
  private readonly cancellationFailures = new Map<string, string>();
  private readonly observedTerminal = new WeakSet<HostAgentHandle>();
  private draining = false;
  private admissionsInFlight = 0;

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
    this.beginAdmission();
    try {
      const handle = await this.base.createAgent(request);
      this.track(handle);
      if (this.draining) void this.requestCancel(handle).catch(() => undefined);
      return handle;
    } finally {
      this.endAdmission();
    }
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    this.assertAccepting();
    this.beginAdmission();
    try {
      const result = await this.base.resumeAgent(request);
      if (result.status === "resumed") {
        this.track(result.handle);
        if (this.draining) void this.requestCancel(result.handle).catch(() => undefined);
      }
      return result;
    } finally {
      this.endAdmission();
    }
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    if (!this.active.has(handle.id) && this.observedTerminal.has(handle)) return;
    await this.requestCancel(handle);
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    let terminalObserved = false;
    try {
      for await (const event of this.base.observeAgent(handle)) {
        yield event;
        if (event.type === "completed" || event.type === "failed") {
          terminalObserved = true;
          return;
        }
      }
    } finally {
      this.release(handle, terminalObserved);
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

  admissionCount(): number {
    return this.admissionsInFlight;
  }

  snapshot(): DrainableHostSnapshot {
    return {
      draining: this.draining,
      activeHandleIds: [...this.active.keys()].sort(),
      admissionsInFlight: this.admissionsInFlight
    };
  }

  async waitForIdle(): Promise<void> {
    if (this.isIdle()) return;
    await new Promise<void>(resolve => this.idleWaiters.add(resolve));
  }

  async cancelActive(): Promise<{ attempted: string[]; failures: Array<{ handleId: string; error: string }> }> {
    this.beginDrain();
    const handles = [...this.active.values()];
    await Promise.all(handles.map(async handle => {
      try {
        await this.requestCancel(handle);
      } catch {
        // Failure is retained below while the rest of the active set is still cancelled.
      }
    }));
    return {
      attempted: handles.map(handle => handle.id),
      failures: handles.flatMap(handle => {
        const error = this.cancellationFailures.get(handle.id);
        return error ? [{ handleId: handle.id, error }] : [];
      })
    };
  }

  closeIfIdle(): void {
    this.beginDrain();
    if (!this.isIdle()) {
      throw new Error(
        `Cannot close HostAdapter with ${this.active.size} active Mission session(s) and ` +
        `${this.admissionsInFlight} admission(s) in flight`
      );
    }
  }

  private assertAccepting(): void {
    if (this.draining) throw new Error("Mission Runtime host is draining and cannot create or resume agent sessions");
  }

  private beginAdmission(): void {
    this.admissionsInFlight += 1;
  }

  private endAdmission(): void {
    this.admissionsInFlight = Math.max(0, this.admissionsInFlight - 1);
    this.notifyIdleIfNeeded();
  }

  private track(handle: HostAgentHandle): void {
    const existing = this.active.get(handle.id);
    if (existing) {
      throw new Error(
        `Host reused active handle id ${handle.id}` +
        (existing.nativeRef === handle.nativeRef ? "" : " for a different native session")
      );
    }
    this.observedTerminal.delete(handle);
    this.active.set(handle.id, handle);
  }

  private release(handle: HostAgentHandle, terminalObserved: boolean): void {
    if (!this.active.delete(handle.id)) return;
    if (terminalObserved) this.observedTerminal.add(handle);
    this.cancellationTasks.delete(handle.id);
    this.cancellationFailures.delete(handle.id);
    this.notifyIdleIfNeeded();
  }

  private requestCancel(handle: HostAgentHandle): Promise<void> {
    const existing = this.cancellationTasks.get(handle.id);
    if (existing) return existing;

    const task = this.base.cancelAgent(handle).catch(error => {
      this.cancellationFailures.set(handle.id, error instanceof Error ? error.message : String(error));
      throw error;
    });
    this.cancellationTasks.set(handle.id, task);
    return task;
  }

  private isIdle(): boolean {
    return this.active.size === 0 && this.admissionsInFlight === 0;
  }

  private notifyIdleIfNeeded(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
