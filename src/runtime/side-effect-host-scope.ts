import type { SideEffectPolicy } from "../core/domain/execution.ts";
import type { AgentCreateRequest, AgentResumeRequest, ApprovalRequest } from "../hosts/deepseek/host-adapter.ts";

interface HostSideEffectScope {
  missionId: string;
  workItemId: string;
  attemptId?: string;
  executionId?: string;
  workspaceRoot?: string;
  sideEffectPolicy?: SideEffectPolicy;
}

/**
 * Provider permission callbacks do not necessarily echo the full runtime
 * execution request. This registry restores only Runtime-owned control metadata
 * by Mission/Work identity; provider-supplied tool payloads cannot overwrite it.
 */
export class HostSideEffectScopeRegistry {
  private readonly scopes = new Map<string, HostSideEffectScope>();

  register(request: AgentCreateRequest | AgentResumeRequest): () => void {
    const key = scopeKey(request.missionId, request.workItemId);
    const next: HostSideEffectScope = {
      missionId: request.missionId,
      workItemId: request.workItemId,
      ...(request.attemptId ? { attemptId: request.attemptId } : {}),
      ...(request.executionId ? { executionId: request.executionId } : {}),
      ...(request.workspaceRoot ? { workspaceRoot: request.workspaceRoot } : {}),
      ...(request.sideEffectPolicy ? { sideEffectPolicy: { ...request.sideEffectPolicy } } : {})
    };
    const current = this.scopes.get(key);
    if (current && !sameScope(current, next)) {
      throw new Error(`Concurrent Host side-effect scopes for one WorkItem are not supported: ${request.workItemId}`);
    }
    this.scopes.set(key, next);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const active = this.scopes.get(key);
      if (active && sameScope(active, next)) this.scopes.delete(key);
    };
  }

  enrich(request: ApprovalRequest): ApprovalRequest {
    const workItemId = optionalString(request.details?.workItemId);
    if (!workItemId) return request;
    const scope = this.scopes.get(scopeKey(request.missionId, workItemId));
    if (!scope) return request;
    return {
      ...request,
      details: {
        ...(request.details ?? {}),
        workItemId: scope.workItemId,
        ...(scope.attemptId ? { attemptId: scope.attemptId } : {}),
        ...(scope.executionId ? { executionId: scope.executionId } : {}),
        ...(scope.workspaceRoot ? { workspaceRoot: scope.workspaceRoot } : {}),
        ...(scope.sideEffectPolicy ? { sideEffectPolicy: { ...scope.sideEffectPolicy } } : {})
      }
    };
  }
}

function scopeKey(missionId: string, workItemId: string): string {
  return `${missionId}\u0000${workItemId}`;
}

function sameScope(left: HostSideEffectScope, right: HostSideEffectScope): boolean {
  return left.missionId === right.missionId &&
    left.workItemId === right.workItemId &&
    left.attemptId === right.attemptId &&
    left.executionId === right.executionId &&
    left.workspaceRoot === right.workspaceRoot &&
    JSON.stringify(left.sideEffectPolicy ?? null) === JSON.stringify(right.sideEffectPolicy ?? null);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
