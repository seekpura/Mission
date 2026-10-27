import { randomUUID } from "node:crypto";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
import type {
  AgentCreateRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAgentEvent,
  HostAgentHandle,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "./host-adapter.ts";
import type { DeepSeekBindings } from "./deepseek-host-adapter.ts";

interface DshAgentLike {
  id: string;
  status: "idle" | "running";
  followup(message: unknown): void;
  steer(message: unknown): void;
  cancel(cause: { kind: "user" }, options?: { keepInbox?: boolean }): void;
  whenIdle(): Promise<void>;
}

interface DshAgentHandleLike {
  agent: DshAgentLike;
  dispose(): Promise<void>;
}

interface DshAgentsLike {
  create(options: {
    sessionId: string;
    parentAgent?: DshAgentLike;
    meta?: { cwd?: string; parentSession?: string; origin?: "subagent"; delegationDepth?: number; agentPreset?: string };
    agentOptions?: Record<string, unknown>;
  }): Promise<DshAgentHandleLike>;
  currentInitiator?(): DshAgentLike | undefined;
}

export interface DeepSeekContextLike {
  agents: DshAgentsLike;
}

export interface OfficialDeepSeekBindingOptions {
  version?: string;
  capabilities?: () => Promise<CapabilityDescriptor[]> | CapabilityDescriptor[];
  createUserMessage(input: { content: Array<{ type: "text"; text: string }>; source: { kind: "user" } }): unknown;
  renderContext?: (context: unknown, request: AgentCreateRequest) => string;
  summarizeAgent?: (agent: DshAgentLike) => Promise<string> | string;
  invokeCapability?: (request: HostCapabilityInvocation) => Promise<HostCapabilityResult>;
  requestApproval?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  shellAvailable?: boolean;
  filesystemAvailable?: boolean;
  browserAvailable?: boolean;
  agentOptions?: Record<string, unknown>;
  agentPreset?: string;
}

interface LiveAgent {
  native: DshAgentHandleLike;
  queue: AsyncEventQueue<HostAgentEvent>;
  settled: Promise<void>;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: IteratorResult<T>) => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as T, done: true });
  }

  async *iterate(): AsyncIterable<T> {
    while (true) {
      if (this.values.length > 0) {
        yield this.values.shift()!;
        continue;
      }
      if (this.ended) return;
      const item = await new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
      if (item.done) return;
      yield item.value;
    }
  }
}

/**
 * Version-aware binding against the public DSH AgentRegistry/Agent surface.
 * It intentionally depends only on the public structural contract so the Mission core
 * does not import DSH packages. The DSH plugin supplies createUserMessage and optional
 * host-specific helpers from the exact installed Harness version.
 */
export class OfficialDeepSeekBindings implements DeepSeekBindings {
  private readonly ctx: DeepSeekContextLike;
  private readonly options: OfficialDeepSeekBindingOptions;
  private readonly live = new Map<string, LiveAgent>();

  constructor(ctx: DeepSeekContextLike, options: OfficialDeepSeekBindingOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  async describe(): Promise<HostDescriptor> {
    return {
      type: "deepseek-harness",
      version: this.options.version,
      metadata: { binding: "official-agent-registry" }
    };
  }

  async environment(): Promise<EnvironmentSnapshot> {
    return {
      revision: Date.now(),
      host: await this.describe(),
      capabilities: await this.options.capabilities?.() ?? [],
      shellAvailable: this.options.shellAvailable ?? true,
      filesystemAvailable: this.options.filesystemAvailable ?? true,
      browserAvailable: this.options.browserAvailable ?? true,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const handleId = `mission-${request.missionId}-${request.workItemId}-${randomUUID().slice(0, 8)}`;
    const parentAgent = this.ctx.agents.currentInitiator?.();
    const meta = {
      ...(request.workspaceRoot ? { cwd: request.workspaceRoot } : {}),
      ...(parentAgent ? { origin: "subagent" as const } : {}),
      ...(this.options.agentPreset ? { agentPreset: this.options.agentPreset } : {})
    };
    const native = await this.ctx.agents.create({
      sessionId: handleId,
      parentAgent,
      meta: Object.keys(meta).length > 0 ? meta : undefined,
      agentOptions: this.options.agentOptions
    });
    const queue = new AsyncEventQueue<HostAgentEvent>();
    queue.push({ type: "started", payload: { sessionId: native.agent.id }, at: new Date().toISOString() });

    const text = this.options.renderContext
      ? this.options.renderContext(request.context, request)
      : renderDefaultContext(request.context, request);
    native.agent.followup(this.options.createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "user" }
    }));

    const settled = this.settleAgent(handleId, native, queue);
    this.live.set(handleId, { native, queue, settled });
    return { id: handleId, nativeRef: String(native.agent.id) };
  }

  async steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    const live = this.requireLive(handle.id);
    const message = delta.message ?? JSON.stringify(delta);
    live.native.agent.steer(this.options.createUserMessage({
      content: [{ type: "text", text: message }],
      source: { kind: "user" }
    }));
    live.queue.push({ type: "message", payload: { steering: message }, at: new Date().toISOString() });
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    const live = this.live.get(handle.id);
    if (!live) return;
    live.native.agent.cancel({ kind: "user" });
    await live.native.agent.whenIdle().catch(() => undefined);
    live.queue.push({ type: "failed", payload: { cancelled: true }, at: new Date().toISOString() });
    live.queue.end();
    await live.native.dispose().catch(() => undefined);
    this.live.delete(handle.id);
  }

  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const live = this.requireLive(handle.id);
    const self = this;
    return (async function* () {
      try {
        yield* live.queue.iterate();
      } finally {
        if (self.live.get(handle.id) === live) self.live.delete(handle.id);
      }
    })();
  }

  async invokeCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    if (!this.options.invokeCapability) return { ok: false, error: `Direct capability invocation is not bound for ${request.capabilityId}` };
    return this.options.invokeCapability(request);
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.options.requestApproval) return { approved: false };
    return this.options.requestApproval(request);
  }

  private async settleAgent(id: string, native: DshAgentHandleLike, queue: AsyncEventQueue<HostAgentEvent>): Promise<void> {
    try {
      await native.agent.whenIdle();
      const text = await this.options.summarizeAgent?.(native.agent) ?? "";
      queue.push({ type: "completed", payload: { sessionId: native.agent.id, text }, at: new Date().toISOString() });
    } catch (error) {
      queue.push({ type: "failed", payload: { error: error instanceof Error ? error.message : String(error) }, at: new Date().toISOString() });
    } finally {
      queue.end();
      await native.dispose().catch(() => undefined);
    }
  }

  private requireLive(id: string): LiveAgent {
    const live = this.live.get(id);
    if (!live) throw new Error(`Unknown or settled DSH agent handle: ${id}`);
    return live;
  }
}

function renderDefaultContext(context: unknown, request: AgentCreateRequest): string {
  return [
    "You are a Mission Runtime worker. Complete the assigned work item and report concrete outputs.",
    `Mission: ${request.missionId}`,
    `Work item: ${request.workItemId}`,
    "Context packet:",
    typeof context === "string" ? context : JSON.stringify(context, null, 2)
  ].join("\n\n");
}
