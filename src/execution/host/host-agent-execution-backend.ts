import type { ExecutionRequest, ExecutionResult } from "../../core/domain/execution.ts";
import type { HostAdapter, HostAgentHandle } from "../../hosts/deepseek/host-adapter.ts";

export interface HostAgentExecutionRequest extends ExecutionRequest {
  context: unknown;
  workspaceRoot?: string;
}

export interface HostExecutionHandle {
  id: string;
  request: HostAgentExecutionRequest;
  agent?: HostAgentHandle;
}

export class HostAgentExecutionBackend {
  private readonly host: HostAdapter;
  private readonly active = new Map<string, Promise<ExecutionResult>>();
  private readonly cancelled = new Set<string>();

  constructor(host: HostAdapter) { this.host = host; }

  async allocate(request: HostAgentExecutionRequest): Promise<HostExecutionHandle> {
    if (request.executor.type !== "host_agent") throw new Error("HostAgentExecutionBackend requires executor.type=host_agent");
    return { id: request.executionId, request };
  }

  async start(handle: HostExecutionHandle): Promise<void> {
    if (this.active.has(handle.id)) throw new Error(`Execution already active: ${handle.id}`);
    handle.agent = await this.host.createAgent({
      missionId: handle.request.missionId,
      workItemId: handle.request.workItemId,
      context: handle.request.context,
      allowedCapabilityRefs: handle.request.capabilityRefs,
      workspaceRoot: handle.request.workspaceRoot,
      preferredExecutorRefs: handle.request.preferredExecutorRefs,
      excludeExecutorRefs: handle.request.excludeExecutorRefs,
      forceFreshAgent: handle.request.forceFreshAgent
    });
    this.active.set(handle.id, this.observe(handle));
  }

  async collect(handle: HostExecutionHandle): Promise<ExecutionResult> {
    const promise = this.active.get(handle.id);
    if (!promise) throw new Error(`Execution not started: ${handle.id}`);
    const result = await promise;
    this.active.delete(handle.id);
    this.cancelled.delete(handle.id);
    return result;
  }

  async cancel(handle: HostExecutionHandle): Promise<void> {
    if (!handle.agent) return;
    this.cancelled.add(handle.id);
    await this.host.cancelAgent(handle.agent);
  }

  async recover(executionId: string): Promise<"running" | "lost"> {
    return this.active.has(executionId) ? "running" : "lost";
  }

  private async observe(handle: HostExecutionHandle): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    let completedPayload: unknown;
    let failure: string | undefined;
    if (!handle.agent) throw new Error("Host agent missing after start");
    for await (const event of this.host.observeAgent(handle.agent)) {
      if (event.type === "completed") completedPayload = event.payload;
      if (event.type === "failed") failure = typeof event.payload === "string" ? event.payload : JSON.stringify(event.payload);
    }
    return {
      executionId: handle.id,
      state: this.cancelled.has(handle.id) ? "cancelled" : failure ? "failed" : "succeeded",
      executorRef: handle.agent.nativeRef ?? handle.agent.id,
      producedFiles: [],
      committedArtifactRefs: [],
      runtimeObservationRef: completedPayload === undefined ? undefined : JSON.stringify(completedPayload),
      sideEffects: [],
      startedAt,
      endedAt: new Date().toISOString()
    };
  }
}
