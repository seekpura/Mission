import type { ExecutionRuntimeBinding } from "../domain/execution.ts";
import type { MissionEvent } from "../domain/event.ts";

export interface RecoveryExecutionView {
  executionId: string;
  workItemId: string;
  attemptId: string;
  executorId?: string;
  contextPacketId?: string;
  capabilityRefs: string[];
  started: boolean;
  terminal: boolean;
  binding?: ExecutionRuntimeBinding;
  recoveryCount: number;
}

interface AttemptRecoveryContext {
  capabilityRefs: string[];
  contextPacketId?: string;
}

const TERMINAL_EXECUTION_EVENTS = new Set<MissionEvent["type"]>([
  "execution.completed",
  "execution.failed",
  "execution.lost",
  "execution.cancelled"
]);

export function projectExecutionRecovery(events: MissionEvent[]): Map<string, RecoveryExecutionView> {
  const executions = new Map<string, RecoveryExecutionView>();
  const attempts = new Map<string, AttemptRecoveryContext>();

  for (const event of events) {
    switch (event.type) {
      case "attempt.created": {
        const payload = event.payload as {
          id?: string;
          capabilityRefs?: unknown;
          contextPacketId?: string;
        };
        if (!payload.id) break;
        attempts.set(payload.id, {
          capabilityRefs: Array.isArray(payload.capabilityRefs)
            ? payload.capabilityRefs.filter((ref): ref is string => typeof ref === "string")
            : [],
          ...(payload.contextPacketId ? { contextPacketId: payload.contextPacketId } : {})
        });
        break;
      }
      case "execution.created": {
        const payload = event.payload as {
          id?: string;
          workItemId?: string;
          attemptId?: string;
          executorId?: string;
          contextPacketId?: string;
        };
        if (!payload.id || !payload.workItemId || !payload.attemptId) break;
        const attempt = attempts.get(payload.attemptId);
        executions.set(payload.id, {
          executionId: payload.id,
          workItemId: payload.workItemId,
          attemptId: payload.attemptId,
          ...(payload.executorId ? { executorId: payload.executorId } : {}),
          ...(payload.contextPacketId || attempt?.contextPacketId
            ? { contextPacketId: payload.contextPacketId ?? attempt!.contextPacketId }
            : {}),
          capabilityRefs: [...(attempt?.capabilityRefs ?? [])],
          started: false,
          terminal: false,
          recoveryCount: 0
        });
        break;
      }
      case "execution.started": {
        const id = executionId(event.payload);
        const current = id ? executions.get(id) : undefined;
        if (current) current.started = true;
        break;
      }
      case "execution.bound": {
        const payload = event.payload as { binding?: ExecutionRuntimeBinding } & Partial<ExecutionRuntimeBinding>;
        const binding = payload.binding ?? asBinding(payload);
        const current = binding ? executions.get(binding.executionId) : undefined;
        if (current && binding) current.binding = { ...binding };
        break;
      }
      case "execution.recovery.started": {
        const id = executionId(event.payload);
        const current = id ? executions.get(id) : undefined;
        if (current) current.recoveryCount += 1;
        break;
      }
      default: {
        if (!TERMINAL_EXECUTION_EVENTS.has(event.type)) break;
        const id = executionId(event.payload);
        const current = id ? executions.get(id) : undefined;
        if (current) current.terminal = true;
      }
    }
  }

  return executions;
}

export function activeExecutions(events: MissionEvent[]): RecoveryExecutionView[] {
  return [...projectExecutionRecovery(events).values()]
    .filter(execution => execution.started && !execution.terminal)
    .sort((a, b) => a.executionId.localeCompare(b.executionId));
}

function executionId(payload: unknown): string | undefined {
  const id = (payload as { id?: unknown })?.id;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

function asBinding(payload: Partial<ExecutionRuntimeBinding>): ExecutionRuntimeBinding | undefined {
  if (!payload.executionId || !payload.attemptId || !payload.workItemId || !payload.driverId ||
      !payload.hostHandleId || !payload.workspaceRoot || !payload.boundAt) return undefined;
  return {
    executionId: payload.executionId,
    attemptId: payload.attemptId,
    workItemId: payload.workItemId,
    driverId: payload.driverId,
    ...(payload.routeId ? { routeId: payload.routeId } : {}),
    hostHandleId: payload.hostHandleId,
    ...(payload.nativeRef ? { nativeRef: payload.nativeRef } : {}),
    workspaceRoot: payload.workspaceRoot,
    boundAt: payload.boundAt
  };
}
