#!/usr/bin/env bash
set -euo pipefail
mkdir -p src/runtime/recovery tests/integration tests/unit

cat > src/execution/local/process-manager.ts <<'EOF'
import { spawn } from "node:child_process";

export interface ProcessSpec {
  executionId?: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: string;
  endedAt: string;
}

export class ProcessManager {
  private readonly active = new Map<string, ReturnType<typeof spawn>>();
  private readonly cancelled = new Set<string>();

  async run(spec: ProcessSpec): Promise<ProcessRunResult> {
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
      if (spec.executionId) this.active.set(spec.executionId, child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", d => { stdout += d; });
      child.stderr?.on("data", d => { stderr += d; });
      const timer = spec.timeoutMs ? setTimeout(() => {
        timedOut = true;
        this.terminate(child, "SIGTERM");
        setTimeout(() => this.terminate(child, "SIGKILL"), 1000).unref();
      }, spec.timeoutMs) : undefined;
      timer?.unref();
      child.on("error", error => {
        if (spec.executionId) this.active.delete(spec.executionId);
        reject(error);
      });
      child.on("close", code => {
        if (timer) clearTimeout(timer);
        const cancelled = spec.executionId ? this.cancelled.delete(spec.executionId) : false;
        if (spec.executionId) this.active.delete(spec.executionId);
        resolve({ exitCode: code, stdout, stderr, timedOut, cancelled, startedAt, endedAt: new Date().toISOString() });
      });
    });
  }

  async cancel(executionId: string): Promise<boolean> {
    const child = this.active.get(executionId);
    if (!child) return false;
    this.cancelled.add(executionId);
    this.terminate(child, "SIGTERM");
    setTimeout(() => {
      if (this.active.has(executionId)) this.terminate(child, "SIGKILL");
    }, 1000).unref();
    return true;
  }

  isActive(executionId: string): boolean { return this.active.has(executionId); }

  private terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch {}
    }
    try { child.kill(signal); } catch {}
  }
}
EOF

python - <<'PY'
from pathlib import Path

p=Path('src/execution/local/local-execution-backend.ts')
s=p.read_text()
s=s.replace('  async cancel(handle: ExecutionHandle): Promise<void> {\n    if (!this.active.has(handle.id)) return;\n  }', '  async cancel(handle: ExecutionHandle): Promise<void> {\n    if (!this.active.has(handle.id)) return;\n    await this.processes.cancel(handle.id);\n  }')
s=s.replace('    const run = await this.processes.run({\n      command:', '    const run = await this.processes.run({\n      executionId: r.executionId,\n      command:')
s=s.replace('      state: run.timedOut ? "timed_out" : run.exitCode === 0 ? "succeeded" : "failed",', '      state: run.cancelled ? "cancelled" : run.timedOut ? "timed_out" : run.exitCode === 0 ? "succeeded" : "failed",')
p.write_text(s)

p=Path('src/execution/host/host-agent-execution-backend.ts')
s=p.read_text()
s=s.replace('  private readonly active = new Map<string, Promise<ExecutionResult>>();', '  private readonly active = new Map<string, Promise<ExecutionResult>>();\n  private readonly cancelled = new Set<string>();')
s=s.replace('    const result = await promise;\n    this.active.delete(handle.id);\n    return result;', '    const result = await promise;\n    this.active.delete(handle.id);\n    this.cancelled.delete(handle.id);\n    return result;')
s=s.replace('  async cancel(handle: HostExecutionHandle): Promise<void> {\n    if (handle.agent) await this.host.cancelAgent(handle.agent);\n  }', '  async cancel(handle: HostExecutionHandle): Promise<void> {\n    if (!handle.agent) return;\n    this.cancelled.add(handle.id);\n    await this.host.cancelAgent(handle.agent);\n  }')
s=s.replace('      state: failure ? "failed" : "succeeded",', '      state: this.cancelled.has(handle.id) ? "cancelled" : failure ? "failed" : "succeeded",')
p.write_text(s)

for path in ['src/execution/resources/resource-manager.ts','src/execution/artifacts/artifact-lease-manager.ts']:
    p=Path(path); s=p.read_text()
    if 'releaseOwner(ownerId: string)' in s: continue
    method='''\n  releaseOwner(ownerId: string): void {\n    for (const [resource, owner] of [...this.holders.entries()]) {\n      if (owner === ownerId) this.holders.delete(resource);\n    }\n    const waiters = this.waiters.splice(0);\n    for (const waiter of waiters) waiter();\n  }\n\n  isHeld(resource: string): boolean { return this.holders.has(resource); }\n'''
    if 'ResourceManager' in s:
        s=s.replace('\n  private canAcquire(ownerId: string, resources: string[]): boolean {', method+'\n  private canAcquire(ownerId: string, resources: string[]): boolean {')
    else:
        method2='''\n  releaseOwner(ownerId: string): void {\n    for (const [name, owner] of [...this.writers.entries()]) {\n      if (owner === ownerId) this.writers.delete(name);\n    }\n    const waiters = this.waiters.splice(0);\n    for (const waiter of waiters) waiter();\n  }\n\n  isHeld(logicalName: string): boolean { return this.writers.has(logicalName); }\n'''
        s=s.replace('\n}', method2+'\n}')
    p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/executor-router.ts')
s=p.read_text()
s=s.replace('  requiresApproval: boolean;\n}', '  requiresApproval: boolean;\n  cancellable: boolean;\n}')
s=s.replace('  private readonly audit?: ExecutionAuditObserver;', '  private readonly audit?: ExecutionAuditObserver;\n  private readonly active = new Map<string, { cancel?: () => Promise<void>; settled: Promise<void> }>();')
marker='''  async execute(input: RoutedExecutionInput): Promise<RoutedExecutionResult> {'''
method='''  async cancel(executionId: string): Promise<boolean> {\n    const active = this.active.get(executionId);\n    if (!active?.cancel) return false;\n    await active.cancel();\n    await active.settled;\n    this.resources.releaseOwner(executionId);\n    this.artifactLeases.releaseOwner(executionId);\n    return true;\n  }\n\n  async recover(executionId: string): Promise<"running" | "lost"> {\n    return this.active.has(executionId) ? "running" : "lost";\n  }\n\n'''
if marker not in s: raise SystemExit('router execute marker missing')
s=s.replace(marker, method+marker)
old_agent='''  private async executeAgent(input: RoutedExecutionInput): Promise<ExecutionResult> {\n    const handle = await this.agents.allocate(input.baseRequest);\n    await this.agents.start(handle);\n    return this.agents.collect(handle);\n  }'''
new_agent='''  private async executeAgent(input: RoutedExecutionInput): Promise<ExecutionResult> {\n    const handle = await this.agents.allocate(input.baseRequest);\n    await this.agents.start(handle);\n    return this.track(input.baseRequest.executionId, () => this.agents.cancel(handle), this.agents.collect(handle));\n  }'''
if old_agent not in s: raise SystemExit('agent helper missing')
s=s.replace(old_agent,new_agent)
old_host='''    const handle = await this.hostCapabilities.allocate(request);\n    await this.hostCapabilities.start(handle);\n    return this.hostCapabilities.collect(handle);'''
new_host='''    const handle = await this.hostCapabilities.allocate(request);\n    await this.hostCapabilities.start(handle);\n    return this.track(input.baseRequest.executionId, undefined, this.hostCapabilities.collect(handle));'''
s=s.replace(old_host,new_host)
old_local='''    const handle = await this.local.allocate(request);\n    await this.local.start(handle);\n    return this.local.collect(handle);\n  }'''
new_local='''    const handle = await this.local.allocate(request);\n    await this.local.start(handle);\n    return this.track(input.baseRequest.executionId, () => this.local.cancel(handle), this.local.collect(handle));\n  }\n\n  private async track(executionId: string, cancel: (() => Promise<void>) | undefined, collected: Promise<ExecutionResult>): Promise<ExecutionResult> {\n    const settled = collected.then(() => undefined, () => undefined);\n    this.active.set(executionId, { cancel, settled });\n    try { return await collected; }\n    finally { this.active.delete(executionId); }\n  }'''
if old_local not in s: raise SystemExit('local helper missing')
s=s.replace(old_local,new_local)
s=s.replace('    requiresApproval,\n    resourceRequest:', '    requiresApproval,\n    cancellable: kind === "host_agent" || kind === "local_cli",\n    resourceRequest:')
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/core/domain/event.ts')
s=p.read_text().replace('  | "execution.started"\n  | "execution.route.selected"', '  | "execution.started"\n  | "execution.cancel.requested"\n  | "execution.route.selected"')
p.write_text(s)

p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()
s=s.replace('const selectedRoute: ExecutionRoute = this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", sideEffectPolicy:', 'const selectedRoute: ExecutionRoute = this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", cancellable: true, sideEffectPolicy:')
s=s.replace('await this.controller.emit(work.missionId, result.state === "succeeded" ? "execution.completed" : "execution.failed", { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);\n      const envelope = parseWorkerOutput(result.runtimeObservationRef);\n      if (result.state !== "succeeded" || envelope?.status === "failed") {', 'const settledEvent = result.state === "succeeded" ? "execution.completed" : result.state === "cancelled" ? "execution.cancelled" : "execution.failed";\n      await this.controller.emit(work.missionId, settledEvent, { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);\n      if (result.state === "cancelled") {\n        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "cancelled", reason: "Execution cancelled" }, { type: "controller" }, `attempt-completed:${attemptId}`);\n        await this.controller.emit(work.missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution cancelled; awaiting reschedule or user direction" }, { type: "controller" }, `work-cancelled:${work.id}:${attemptId}`);\n        return;\n      }\n      const envelope = parseWorkerOutput(result.runtimeObservationRef);\n      if (result.state !== "succeeded" || envelope?.status === "failed") {')
p.write_text(s)
PY

cat > src/runtime/recovery/execution-recovery-manager.ts <<'EOF'
import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { WorkExecutionRouter } from "../orchestration/executor-router.ts";

export interface RecoverySummary { running: string[]; lost: string[]; }

export class ExecutionRecoveryManager {
  constructor(private readonly input: {
    controller: MissionController;
    events: EventStore;
    projections: MissionProjectionReader;
    router: WorkExecutionRouter;
  }) {}

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
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { WorkExecutionRouter } from "./orchestration/executor-router.ts";', 'import { WorkExecutionRouter } from "./orchestration/executor-router.ts";\nimport { ExecutionRecoveryManager } from "./recovery/execution-recovery-manager.ts";')
s=s.replace('  readonly orchestrator?: MissionOrchestrator;', '  readonly orchestrator?: MissionOrchestrator;\n  readonly executionRouter?: WorkExecutionRouter;\n  readonly recovery?: ExecutionRecoveryManager;')
s=s.replace('      const executionRouter = new WorkExecutionRouter({', '      const executionRouter = new WorkExecutionRouter({')
s=s.replace('      this.orchestrator = new MissionOrchestrator({', '      this.executionRouter = executionRouter;\n      this.recovery = new ExecutionRecoveryManager({ controller: this.controller, events: this.events, projections: this.projections, router: executionRouter });\n      this.orchestrator = new MissionOrchestrator({')
insert='''\n  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {\n    if (!this.executionRouter) return false;\n    await this.controller.emit(missionId, "execution.cancel.requested", { id: executionId }, { type: "user" }, `execution-cancel-request:${executionId}`);\n    return this.executionRouter.cancel(executionId);\n  }\n\n  async recoverMission(missionId: string) {\n    if (!this.recovery) return { running: [], lost: [] };\n    return this.recovery.reconcileMission(missionId);\n  }\n'''
s=s.replace('\n  close(): void {', insert+'\n  close(): void {')
p.write_text(s)
PY

cat > tests/unit/process-manager-cancel.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";

test("ProcessManager cancels an owned process", async () => {
  const processes = new ProcessManager();
  const executionId = "cancel-me";
  const running = processes.run({ executionId, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd: mkdtempSync(`${tmpdir()}/mission-process-`), env: { PATH: process.env.PATH ?? "" } });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(processes.isActive(executionId), true);
  assert.equal(await processes.cancel(executionId), true);
  const result = await running;
  assert.equal(result.cancelled, true);
  assert.equal(processes.isActive(executionId), false);
});
EOF

cat > tests/integration/executor-cancellation.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkExecutionRouter } from "../../src/runtime/orchestration/executor-router.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../../src/execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { HostAgentExecutionRequest } from "../../src/execution/host/host-agent-execution-backend.ts";

function work(id: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId: "m", purpose: "production", objective: id, status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "shared", type: "document", required: false }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}

test("cancelling a local execution releases resource and artifact leases for the next execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-cancel-router-"));
  const tool = join(root, "delay.mjs");
  writeFileSync(tool, `import fs from 'node:fs'; const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); setTimeout(()=>console.log(JSON.stringify({status:'completed',summary:'done',outputs:[],proposedFacts:[],proposedWork:[],warnings:[]})), input.delay);`, "utf8");
  const capability: CapabilityDescriptor = { id: "cli", kind: "cli", name: "delay", description: "delay", hostNative: false, available: true, invocationRef: tool, permissions: [], scope: "mission", metadata: { directProtocol: "worker-envelope-stdio", argsTemplate: ["{input}"], exclusiveResources: ["shared-resource"] } };
  const host = new FakeHostAdapter();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new FileArtifactStore(root);
  const router = new WorkExecutionRouter({ host, agents: new HostAgentExecutionBackend(host), hostCapabilities: new HostCapabilityExecutionBackend(host), local: new LocalExecutionBackend(workspaces, artifacts) });
  const request = (id: string, delay: number): HostAgentExecutionRequest => ({ executionId: id, missionId: "m", workItemId: id, attemptId: `a-${id}`, executor: { id: "agent", type: "host_agent" }, contextPacketId: `c-${id}`, inputArtifactRefs: [], expectedOutputs: [], capabilityRefs: [capability.id], workspacePolicy: { mode: "isolated", lifecycle: "attempt" }, isolationPolicy: { level: "restricted", filesystemIsolation: true, networkIsolation: true, processIsolation: true, secretIsolation: true }, permissionEnvelope: { readPaths: [], writePaths: [], network: "deny", allowedEnvKeys: [], subprocess: true, packageInstall: false, secretAccess: "deny", hostMutation: false }, timeoutPolicy: { hardTimeoutMs: 10000 }, retryPolicy: { runtimeRetries: 0 }, sideEffectPolicy: { externalWrites: "deny", destructiveWrites: "deny", irreversibleActions: "deny", idempotencyRequired: true }, context: { delay }, workspaceRoot: join(root, `workspace-${id}`) });
  const first = router.execute({ work: work("w1"), capabilities: [capability], baseRequest: request("e1", 5000) });
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = router.execute({ work: work("w2"), capabilities: [capability], baseRequest: request("e2", 30) });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await router.cancel("e1"), true);
  assert.equal((await first).result.state, "cancelled");
  assert.equal((await second).result.state, "succeeded");
});
EOF

cat > tests/integration/execution-recovery.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";

 test("runtime recovery marks orphaned in-process executions lost without blind retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-recovery-"));
  const missionId = "recover-mission";
  const first = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  await first.controller.createMission(missionId, "recover safely");
  const now = new Date().toISOString();
  await first.controller.proposeWork({ id: "work-1", missionId, purpose: "production", objective: "produce", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
  await first.controller.emit(missionId, "work.started", { id: "work-1" }, { type: "controller" }, "work-start");
  await first.controller.emit(missionId, "execution.created", { id: "execution-orphan", workItemId: "work-1", attemptId: "attempt-orphan" }, { type: "controller" }, "execution-create");
  await first.controller.emit(missionId, "execution.started", { id: "execution-orphan" }, { type: "host" }, "execution-start");
  first.close();

  const recovered = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  const summary = await recovered.recoverMission(missionId);
  assert.deepEqual(summary.lost, ["execution-orphan"]);
  const state = await recovered.controller.state(missionId);
  assert.equal(state.activeExecutionIds.includes("execution-orphan"), false);
  const workItems = await recovered.projections.listWorkItems(missionId);
  assert.equal(workItems.find(work => work.id === "work-1")?.status, "waiting");
  const gaps = await recovered.projections.listGaps(missionId);
  assert.ok(gaps.some(gap => gap.id === "recovery-execution-orphan" && gap.status === "open"));
  recovered.close();
});
EOF

npm test
npm run smoke
git diff --check
