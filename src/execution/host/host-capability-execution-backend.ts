import type { ExecutionRequest, ExecutionResult, SideEffectRecord } from "../../core/domain/execution.ts";
import type { HostAdapter, HostCapabilityInvocation } from "../../hosts/deepseek/host-adapter.ts";

export interface HostCapabilityExecutionRequest extends ExecutionRequest {
  invocation: HostCapabilityInvocation;
}

export interface HostCapabilityExecutionHandle {
  id: string;
  request: HostCapabilityExecutionRequest;
}

export class HostCapabilityExecutionBackend {
  private readonly host: HostAdapter;
  private readonly active = new Map<string, Promise<ExecutionResult>>();

  constructor(host: HostAdapter) { this.host = host; }

  async allocate(request: HostCapabilityExecutionRequest): Promise<HostCapabilityExecutionHandle> {
    if (request.executor.type !== "host_capability") throw new Error("HostCapabilityExecutionBackend requires executor.type=host_capability");
    return { id: request.executionId, request };
  }

  async start(handle: HostCapabilityExecutionHandle): Promise<void> {
    if (this.active.has(handle.id)) throw new Error(`Execution already active: ${handle.id}`);
    this.active.set(handle.id, this.run(handle));
  }

  async collect(handle: HostCapabilityExecutionHandle): Promise<ExecutionResult> {
    const promise = this.active.get(handle.id);
    if (!promise) throw new Error(`Execution not started: ${handle.id}`);
    const result = await promise;
    this.active.delete(handle.id);
    return result;
  }

  async cancel(_handle: HostCapabilityExecutionHandle): Promise<void> {}

  async recover(executionId: string): Promise<"running" | "lost"> {
    return this.active.has(executionId) ? "running" : "lost";
  }

  private async run(handle: HostCapabilityExecutionHandle): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const response = await this.host.invokeHostCapability(handle.request.invocation);
    const sideEffects = response.sideEffects ?? [];
    const violation = sideEffectViolation(sideEffects, handle.request.sideEffectPolicy);
    const ok = response.ok && !violation;
    return {
      executionId: handle.id,
      state: ok ? "succeeded" : "failed",
      producedFiles: [],
      committedArtifactRefs: [],
      runtimeObservationRef: response.output === undefined ? undefined : JSON.stringify(response.output),
      sideEffects,
      logRef: violation ?? response.error,
      startedAt,
      endedAt: new Date().toISOString()
    };
  }
}

function sideEffectViolation(effects: SideEffectRecord[], policy: ExecutionRequest["sideEffectPolicy"]): string | undefined {
  for (const effect of effects) {
    if (["external-write", "message"].includes(effect.type) && policy.externalWrites !== "allow") return `External write side effect is not allowed: ${effect.type}:${effect.target}`;
    if (["deployment", "system-change"].includes(effect.type) && policy.destructiveWrites !== "allow") return `Destructive side effect is not allowed: ${effect.type}:${effect.target}`;
    if (!effect.reversible && policy.irreversibleActions !== "allow") return `Irreversible side effect is not allowed: ${effect.type}:${effect.target}`;
  }
  return undefined;
}
