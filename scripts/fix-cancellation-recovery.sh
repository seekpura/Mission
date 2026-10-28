#!/usr/bin/env bash
set -euo pipefail

cat > src/execution/resources/resource-manager.ts <<'EOF'
export interface ResourceLease {
  ownerId: string;
  resources: string[];
  release(): void;
}

export class ResourceManager {
  private readonly holders = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquire(ownerId: string, resources: string[]): Promise<ResourceLease> {
    const requested = [...new Set(resources)].sort();
    if (requested.length === 0) return { ownerId, resources: [], release() {} };
    while (!this.canAcquire(ownerId, requested)) await new Promise<void>(resolve => this.waiters.push(resolve));
    for (const resource of requested) this.holders.set(resource, ownerId);
    let released = false;
    return {
      ownerId,
      resources: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const resource of requested) if (this.holders.get(resource) === ownerId) this.holders.delete(resource);
        this.wakeWaiters();
      }
    };
  }

  releaseOwner(ownerId: string): void {
    for (const [resource, owner] of [...this.holders.entries()]) if (owner === ownerId) this.holders.delete(resource);
    this.wakeWaiters();
  }

  isHeld(resource: string): boolean { return this.holders.has(resource); }

  private canAcquire(ownerId: string, resources: string[]): boolean {
    return resources.every(resource => !this.holders.has(resource) || this.holders.get(resource) === ownerId);
  }

  private wakeWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
EOF

cat > src/execution/artifacts/artifact-lease-manager.ts <<'EOF'
export interface ArtifactWriteLease {
  ownerId: string;
  logicalNames: string[];
  release(): void;
}

export class ArtifactLeaseManager {
  private readonly writers = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquireWrite(ownerId: string, logicalNames: string[]): Promise<ArtifactWriteLease> {
    const requested = [...new Set(logicalNames.filter(Boolean))].sort();
    if (requested.length === 0) return { ownerId, logicalNames: [], release() {} };
    while (!requested.every(name => !this.writers.has(name) || this.writers.get(name) === ownerId)) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    for (const name of requested) this.writers.set(name, ownerId);
    let released = false;
    return {
      ownerId,
      logicalNames: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const name of requested) if (this.writers.get(name) === ownerId) this.writers.delete(name);
        this.wakeWaiters();
      }
    };
  }

  releaseOwner(ownerId: string): void {
    for (const [name, owner] of [...this.writers.entries()]) if (owner === ownerId) this.writers.delete(name);
    this.wakeWaiters();
  }

  isHeld(logicalName: string): boolean { return this.writers.has(logicalName); }

  private wakeWaiters(): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }
}
EOF

cat > src/runtime/recovery/execution-recovery-manager.ts <<'EOF'
import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { WorkExecutionRouter } from "../orchestration/executor-router.ts";

export interface RecoverySummary { running: string[]; lost: string[]; }

export interface ExecutionRecoveryDependencies {
  controller: MissionController;
  events: EventStore;
  projections: MissionProjectionReader;
  router: WorkExecutionRouter;
}

export class ExecutionRecoveryManager {
  private readonly input: ExecutionRecoveryDependencies;
  constructor(input: ExecutionRecoveryDependencies) { this.input = input; }

  async reconcileMission(missionId: string): Promise<RecoverySummary> {
    const state = await this.input.controller.state(missionId);
    const events = await this.input.events.list(missionId);
    const workItems = await this.input.projections.listWorkItems(missionId);
    const running: string[] = [];
    const lost: string[] = [];
    for (const executionId of state.activeExecutionIds) {
      if (await this.input.router.recover(executionId) === "running") { running.push(executionId); continue; }
      lost.push(executionId);
      const created = events.find(event => event.type === "execution.created" && (event.payload as any)?.id === executionId);
      const workItemId = (created?.payload as any)?.workItemId as string | undefined;
      const work = workItems.find(item => item.id === workItemId);
      await this.input.controller.emit(missionId, "execution.lost", { id: executionId, workItemId, reason: "Execution handle was not recoverable after runtime restart" }, { type: "system" }, `execution-lost:${executionId}`);
      if (work) {
        await this.input.controller.emit(missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution lost during recovery; inspection required before retry" }, { type: "system" }, `work-recovery-wait:${work.id}:${executionId}`);
        await this.input.controller.openGap(missionId, {
          id: `recovery-${executionId}`, severity: "major", category: "runtime",
          description: `Execution ${executionId} was lost during runtime recovery. Inspect workspace and possible side effects before retrying.`,
          requirementRefs: work.requirementRefs, artifactRefs: work.inputArtifactRefs
        });
      }
    }
    return { running, lost };
  }
}
EOF

python - <<'PY'
from pathlib import Path
p=Path('tests/integration/executor-cancellation.test.ts')
s=p.read_text()
s=s.replace('import { mkdtempSync, writeFileSync } from "node:fs";', 'import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";')
old='''  const request = (id: string, delay: number): HostAgentExecutionRequest => ({ executionId: id, missionId: "m", workItemId: id, attemptId: `a-${id}`, executor: { id: "agent", type: "host_agent" }, contextPacketId: `c-${id}`, inputArtifactRefs: [], expectedOutputs: [], capabilityRefs: [capability.id], workspacePolicy: { mode: "isolated", lifecycle: "attempt" }, isolationPolicy: { level: "restricted", filesystemIsolation: true, networkIsolation: true, processIsolation: true, secretIsolation: true }, permissionEnvelope: { readPaths: [], writePaths: [], network: "deny", allowedEnvKeys: [], subprocess: true, packageInstall: false, secretAccess: "deny", hostMutation: false }, timeoutPolicy: { hardTimeoutMs: 10000 }, retryPolicy: { runtimeRetries: 0 }, sideEffectPolicy: { externalWrites: "deny", destructiveWrites: "deny", irreversibleActions: "deny", idempotencyRequired: true }, context: { delay }, workspaceRoot: join(root, `workspace-${id}`) });'''
new='''  const request = (id: string, delay: number): HostAgentExecutionRequest => {\n    const workspaceRoot = join(root, `workspace-${id}`);\n    mkdirSync(workspaceRoot, { recursive: true });\n    return { executionId: id, missionId: "m", workItemId: id, attemptId: `a-${id}`, executor: { id: "agent", type: "host_agent" }, contextPacketId: `c-${id}`, inputArtifactRefs: [], expectedOutputs: [], capabilityRefs: [capability.id], workspacePolicy: { mode: "isolated", lifecycle: "attempt" }, isolationPolicy: { level: "restricted", filesystemIsolation: true, networkIsolation: true, processIsolation: true, secretIsolation: true }, permissionEnvelope: { readPaths: [], writePaths: [], network: "deny", allowedEnvKeys: [], subprocess: true, packageInstall: false, secretAccess: "deny", hostMutation: false }, timeoutPolicy: { hardTimeoutMs: 10000 }, retryPolicy: { runtimeRetries: 0 }, sideEffectPolicy: { externalWrites: "deny", destructiveWrites: "deny", irreversibleActions: "deny", idempotencyRequired: true }, context: { delay }, workspaceRoot };\n  };'''
if old not in s: raise SystemExit('request block missing')
p.write_text(s.replace(old,new))
PY
