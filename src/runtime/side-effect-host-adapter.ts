import type { SideEffectPolicy } from "../core/domain/execution.ts";
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
import type { RuntimeSideEffectManager } from "./side-effect-manager.ts";

interface SessionContext {
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  workspaceRoot?: string;
}

export interface SideEffectHostAdapterOptions {
  defaultPolicy?: SideEffectPolicy;
}

const CONSERVATIVE_HOST_POLICY: SideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "approval",
  idempotencyRequired: true
};

/**
 * Host boundary that keeps provider-native tool execution under Mission's
 * durable side-effect lifecycle. Permission-gated effects are admitted before
 * execution by RuntimeSideEffectManager; observed effectful tool calls without
 * a matching durable admission fail the execution instead of being silently
 * accepted after the fact.
 */
export class SideEffectHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly sideEffects: RuntimeSideEffectManager;
  private readonly defaultPolicy: SideEffectPolicy;
  private readonly sessions = new Map<string, SessionContext>();

  constructor(base: HostAdapter, sideEffects: RuntimeSideEffectManager, options: SideEffectHostAdapterOptions = {}) {
    this.base = base;
    this.sideEffects = sideEffects;
    this.defaultPolicy = { ...(options.defaultPolicy ?? CONSERVATIVE_HOST_POLICY) };
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return this.base.snapshotEnvironment();
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const normalized = this.withPolicy(request);
    const handle = await this.base.createAgent(normalized);
    this.sessions.set(handle.id, sessionContext(normalized));
    return handle;
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    const normalized = this.withPolicy(request);
    const resumed = await this.base.resumeAgent(normalized);
    if (resumed.status === "resumed") this.sessions.set(resumed.handle.id, sessionContext(normalized));
    return resumed;
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    await this.base.cancelAgent(handle);
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const context = this.sessions.get(handle.id);
    const observed: HostAgentEvent[] = [];
    let terminal: HostAgentEvent | undefined;
    try {
      for await (const event of this.base.observeAgent(handle)) {
        if (event.type === "completed" || event.type === "failed") {
          terminal = event;
          break;
        }
        observed.push(event);
        yield event;
      }

      if (context) {
        let review;
        try {
          review = await this.sideEffects.observeHostEvents({ ...context, events: observed });
        } catch (error) {
          yield {
            type: "failed",
            payload: {
              reason: "Mission side-effect observation failed closed",
              detail: error instanceof Error ? error.message : String(error)
            },
            at: new Date().toISOString()
          };
          return;
        }

        if (review.sideEffects.length > 0) {
          yield {
            type: "tool",
            payload: {
              sessionUpdate: "mission_side_effect_receipt",
              sideEffects: review.sideEffects
            },
            at: new Date().toISOString()
          };
        }
        if (review.violations.length > 0) {
          yield {
            type: "failed",
            payload: {
              reason: "Unadmitted side effect detected",
              violations: review.violations,
              sideEffects: review.sideEffects
            },
            at: new Date().toISOString()
          };
          return;
        }
      }

      if (terminal) yield terminal;
    } finally {
      this.sessions.delete(handle.id);
    }
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.sideEffects.authorizeHostPermission(request);
  }

  private withPolicy<T extends AgentCreateRequest | AgentResumeRequest>(request: T): T {
    return {
      ...request,
      sideEffectPolicy: request.sideEffectPolicy ? { ...request.sideEffectPolicy } : { ...this.defaultPolicy }
    };
  }
}

function sessionContext(request: AgentCreateRequest | AgentResumeRequest): SessionContext {
  return {
    missionId: request.missionId,
    workItemId: request.workItemId,
    attemptId: request.attemptId ?? "unknown-attempt",
    executionId: request.executionId ?? "unknown-execution",
    ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {})
  };
}
