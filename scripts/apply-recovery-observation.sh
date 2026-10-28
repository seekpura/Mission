#!/usr/bin/env bash
set -euo pipefail
mkdir -p src/runtime/recovery tests/integration

cat > src/runtime/recovery/recovery-manifest.ts <<'EOF'
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideEffectRecord } from "../../core/domain/execution.ts";
import type { InvocationRoute } from "../../core/domain/invocation.ts";
import { parseWorkerOutput, WORKER_RECOVERY_FILE, type WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";

export const EXECUTION_RECOVERY_MANIFEST = ".mission-execution-result.json";

export interface ExecutionRecoveryManifest {
  schemaVersion: 1;
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  route: InvocationRoute;
  routeReason: string;
  capabilityRefs: string[];
  targetRef?: string;
  approvalRef?: string;
  result: "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "lost";
  sideEffects: SideEffectRecord[];
  envelope: WorkerOutputEnvelope | null;
  startedAt: string;
  endedAt: string;
  writtenAt: string;
}

export function writeExecutionRecoveryManifest(workspaceRoot: string, manifest: ExecutionRecoveryManifest): void {
  const target = join(workspaceRoot, EXECUTION_RECOVERY_MANIFEST);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(temporary, target);
}

export function readExecutionRecoveryManifest(workspaceRoot: string): ExecutionRecoveryManifest | null {
  const path = join(workspaceRoot, EXECUTION_RECOVERY_MANIFEST);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ExecutionRecoveryManifest;
    if (value?.schemaVersion !== 1 || typeof value.executionId !== "string" || typeof value.attemptId !== "string") return null;
    return value;
  } catch { return null; }
}

export function readWorkerRecoveryEnvelope(workspaceRoot: string): WorkerOutputEnvelope | null {
  const path = join(workspaceRoot, WORKER_RECOVERY_FILE);
  if (!existsSync(path)) return null;
  try { return parseWorkerOutput(readFileSync(path, "utf8")); }
  catch { return null; }
}
EOF

cat > src/runtime/recovery/recovery-observation-inspector.ts <<'EOF'
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArtifactType } from "../../core/domain/artifact.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import { WORKER_RECOVERY_FILE } from "../../core/execution/worker-output.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import { EXECUTION_RECOVERY_MANIFEST, readExecutionRecoveryManifest, readWorkerRecoveryEnvelope, type ExecutionRecoveryManifest } from "./recovery-manifest.ts";

export type RecoveryObservation =
  | { kind: "recoverable"; workspaceRoot: string; envelope: WorkerOutputEnvelope; manifest: ExecutionRecoveryManifest | null; source: "execution-manifest" | "worker-envelope" | "expected-paths" }
  | { kind: "partial"; workspaceRoot: string; files: string[]; manifest: ExecutionRecoveryManifest | null; reason: string }
  | { kind: "none"; reason: string };

export class RecoveryObservationInspector {
  constructor(private readonly workspaces: WorkspaceManager) {}

  inspect(work: WorkItem, attemptId: string, executionId: string): RecoveryObservation {
    const workspace = this.workspaces.locate(work.missionId, attemptId);
    if (!workspace) return { kind: "none", reason: "Attempt workspace no longer exists" };
    const manifest = readExecutionRecoveryManifest(workspace.root);
    if (manifest && manifest.executionId === executionId && manifest.result === "succeeded") {
      const envelope = manifest.envelope ?? readWorkerRecoveryEnvelope(workspace.root) ?? this.synthesizeExpectedEnvelope(work, workspace.root);
      if (envelope && envelope.status !== "failed") return { kind: "recoverable", workspaceRoot: workspace.root, envelope, manifest, source: "execution-manifest" };
    }
    const workerEnvelope = readWorkerRecoveryEnvelope(workspace.root);
    if (workerEnvelope && workerEnvelope.status !== "failed") return { kind: "recoverable", workspaceRoot: workspace.root, envelope: workerEnvelope, manifest, source: "worker-envelope" };
    const expected = this.synthesizeExpectedEnvelope(work, workspace.root);
    if (expected) return { kind: "recoverable", workspaceRoot: workspace.root, envelope: expected, manifest, source: "expected-paths" };
    const files = this.listMeaningfulFiles(workspace.root);
    if (files.length > 0 || (manifest?.sideEffects.length ?? 0) > 0) {
      return { kind: "partial", workspaceRoot: workspace.root, files, manifest, reason: files.length > 0 ? "Workspace contains unverified partial outputs" : "Execution recorded side effects without recoverable output evidence" };
    }
    return { kind: "none", reason: "No recoverable output evidence was found in the attempt workspace" };
  }

  private synthesizeExpectedEnvelope(work: WorkItem, workspaceRoot: string): WorkerOutputEnvelope | null {
    const declared = work.expectedOutputs.filter(output => typeof output.path === "string" && output.path.length > 0);
    if (declared.length === 0) {
      if (work.expectedOutputs.length === 0) return { status: "completed", summary: "Recovered completed non-artifact work", outputs: [], proposedFacts: [], proposedWork: [], warnings: [] };
      return null;
    }
    if (declared.some(output => output.required && !existsSync(join(workspaceRoot, output.path!)))) return null;
    const existing = declared.filter(output => existsSync(join(workspaceRoot, output.path!)));
    if (existing.length === 0) return null;
    return {
      status: "completed",
      summary: "Recovered outputs from declared artifact paths",
      outputs: existing.map(output => ({ path: output.path!, logicalName: output.logicalName, type: artifactType(output.type), requirementRefs: [] })),
      proposedFacts: [], proposedWork: [], warnings: []
    };
  }

  private listMeaningfulFiles(root: string): string[] {
    const output: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) { visit(absolute); continue; }
        if (!entry.isFile()) continue;
        const rel = relative(root, absolute);
        if ([EXECUTION_RECOVERY_MANIFEST, WORKER_RECOVERY_FILE].includes(rel)) continue;
        if (statSync(absolute).size > 0) output.push(rel);
      }
    };
    visit(root);
    return output.sort();
  }
}

function artifactType(value: string): ArtifactType {
  const allowed: ArtifactType[] = ["file", "document", "presentation", "image", "video", "audio", "code", "website", "dataset", "research", "other"];
  return allowed.includes(value as ArtifactType) ? value as ArtifactType : "file";
}
EOF

python - <<'PY'
from pathlib import Path
p=Path('src/core/domain/work-item.ts')
s=p.read_text().replace('export interface ArtifactExpectation {\n  logicalName: string;\n  type: string;\n  required: boolean;\n}', 'export interface ArtifactExpectation {\n  logicalName: string;\n  type: string;\n  required: boolean;\n  path?: string;\n}')
p.write_text(s)

p=Path('src/core/execution/worker-output.ts')
s=p.read_text()
s=s.replace('export interface WorkerOutputFile {', 'export const WORKER_RECOVERY_FILE = ".mission-worker-output.json";\n\nexport interface WorkerOutputFile {')
s=s.replace('When finished, your FINAL assistant message MUST be one JSON object (no markdown fence):', 'When finished, first write the exact JSON object below to ${workspaceRoot}/${WORKER_RECOVERY_FILE}. Then your FINAL assistant message MUST be the same JSON object (no markdown fence):')
s=s.replace('Do not claim files that do not exist. proposedWork is advisory only; Mission Control decides whether to promote it.', 'The recovery file is part of the execution protocol and must be written before the final response so Mission Control can recover from a runtime crash. Do not claim files that do not exist. proposedWork is advisory only; Mission Control decides whether to promote it.')
p.write_text(s)

p=Path('src/execution/workspace/workspace-manager.ts')
s=p.read_text().replace('import { mkdirSync, rmSync } from "node:fs";', 'import { existsSync, mkdirSync, rmSync } from "node:fs";')
s=s.replace('  cleanup(handle: WorkspaceHandle) {', '  locate(missionId: string, attemptId: string): WorkspaceHandle | null {\n    const path = join(this.root, missionId, "working", attemptId);\n    return existsSync(path) ? { id: `${missionId}:${attemptId}`, missionId, attemptId, root: path } : null;\n  }\n\n  cleanup(handle: WorkspaceHandle) {')
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()
s=s.replace('import type { InvocationReceipt } from "../../core/domain/invocation.ts";', 'import type { InvocationReceipt } from "../../core/domain/invocation.ts";\nimport { writeExecutionRecoveryManifest } from "../recovery/recovery-manifest.ts";')
s=s.replace('    executionRouter?: WorkExecutionRouter;\n    options?: MissionOrchestratorOptions;', '    executionRouter?: WorkExecutionRouter;\n    assurance?: ArtifactAssurancePipeline;\n    options?: MissionOrchestratorOptions;')
s=s.replace('    this.assurance = new ArtifactAssurancePipeline({ controller: input.controller, projections: input.projections, artifacts: input.artifacts, verifier: input.verifier });', '    this.assurance = input.assurance ?? new ArtifactAssurancePipeline({ controller: input.controller, projections: input.projections, artifacts: input.artifacts, verifier: input.verifier });')
old='''      const receipt: InvocationReceipt = {\n        id: `invocation-${executionId}`,'''
new='''      const envelope = parseWorkerOutput(result.runtimeObservationRef);\n      writeExecutionRecoveryManifest(workspace.root, {\n        schemaVersion: 1, missionId: work.missionId, workItemId: work.id, attemptId, executionId,\n        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),\n        targetRef: selectedRoute.capability?.id, approvalRef, result: result.state, sideEffects: result.sideEffects, envelope,\n        startedAt: result.startedAt, endedAt: result.endedAt, writtenAt: new Date().toISOString()\n      });\n      const receipt: InvocationReceipt = {\n        id: `invocation-${executionId}`,'''
if old not in s: raise SystemExit('receipt marker not found')
s=s.replace(old,new)
s=s.replace('      const envelope = parseWorkerOutput(result.runtimeObservationRef);\n      if (result.state !== "succeeded" || envelope?.status === "failed") {', '      if (result.state !== "succeeded" || envelope?.status === "failed") {')
p.write_text(s)
PY

cat > src/runtime/recovery/execution-recovery-manager.ts <<'EOF'
import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { InvocationReceipt, InvocationRoute } from "../../core/domain/invocation.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { WorkExecutionRouter } from "../orchestration/executor-router.ts";
import type { ArtifactAssurancePipeline } from "../orchestration/artifact-assurance-pipeline.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import { RecoveryObservationInspector } from "./recovery-observation-inspector.ts";

export interface RecoverySummary { running: string[]; recovered: string[]; lost: string[]; }

export interface ExecutionRecoveryDependencies {
  controller: MissionController;
  events: EventStore;
  projections: MissionProjectionReader;
  router: WorkExecutionRouter;
  workspaces: WorkspaceManager;
  assurance: ArtifactAssurancePipeline;
}

export class ExecutionRecoveryManager {
  private readonly input: ExecutionRecoveryDependencies;
  private readonly inspector: RecoveryObservationInspector;
  constructor(input: ExecutionRecoveryDependencies) {
    this.input = input;
    this.inspector = new RecoveryObservationInspector(input.workspaces);
  }

  async reconcileMission(missionId: string): Promise<RecoverySummary> {
    const state = await this.input.controller.state(missionId);
    const events = await this.input.events.list(missionId);
    const workItems = await this.input.projections.listWorkItems(missionId);
    const running: string[] = [];
    const recovered: string[] = [];
    const lost: string[] = [];
    for (const executionId of state.activeExecutionIds) {
      if (await this.input.router.recover(executionId) === "running") { running.push(executionId); continue; }
      const created = events.find(event => event.type === "execution.created" && (event.payload as any)?.id === executionId);
      const workItemId = (created?.payload as any)?.workItemId as string | undefined;
      const attemptId = (created?.payload as any)?.attemptId as string | undefined;
      const work = workItems.find(item => item.id === workItemId);
      if (work && attemptId) {
        const observation = this.inspector.inspect(work, attemptId, executionId);
        if (observation.kind === "recoverable") {
          const outcome = await this.input.assurance.process(work, attemptId, observation.workspaceRoot, observation.envelope);
          if (outcome.ok) {
            await this.recordRecoveredInvocation(missionId, executionId, work, attemptId, events, observation.manifest);
            await this.input.controller.emit(missionId, "execution.completed", { id: executionId, recovered: true, artifactRefs: outcome.artifactRefs, source: observation.source }, { type: "system" }, `execution-settled:${executionId}`);
            await this.input.controller.emit(missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: observation.envelope.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs, recovered: true }, { type: "system" }, `attempt-completed:${attemptId}`);
            await this.input.controller.emit(missionId, "work.completed", { id: work.id, summary: observation.envelope.summary || "Recovered completed work from workspace observation", artifactRefs: outcome.artifactRefs, recovered: true }, { type: "system" }, `work-completed:${work.id}:${attemptId}`);
            if (work.purpose === "repair" && outcome.artifactRefs.length > 0) for (const gapId of work.gapRefs) await this.input.controller.resolveGap(missionId, gapId);
            recovered.push(executionId);
            continue;
          }
          await this.markLost(missionId, executionId, work, `Recovered output evidence failed artifact verification; preserved workspace ${observation.workspaceRoot}`);
          lost.push(executionId);
          continue;
        }
        const reason = observation.kind === "partial"
          ? `${observation.reason}; preserved workspace ${observation.workspaceRoot}; files=${observation.files.join(",") || "none"}`
          : observation.reason;
        await this.markLost(missionId, executionId, work, reason);
        lost.push(executionId);
        continue;
      }
      await this.markLost(missionId, executionId, work, "Execution handle was not recoverable and its WorkItem/Attempt identity could not be reconstructed");
      lost.push(executionId);
    }
    return { running, recovered, lost };
  }

  private async recordRecoveredInvocation(missionId: string, executionId: string, work: WorkItem, attemptId: string, events: Awaited<ReturnType<EventStore["list"]>>, manifest: any): Promise<void> {
    const routeEvent = events.find(event => event.type === "execution.route.selected" && (event.payload as any)?.executionId === executionId);
    const routePayload = (routeEvent?.payload ?? {}) as any;
    const route = (manifest?.route ?? routePayload.route ?? "host_agent") as InvocationRoute;
    const now = new Date().toISOString();
    const receipt: InvocationReceipt = {
      id: `invocation-${executionId}`, missionId, workItemId: work.id, attemptId, executionId,
      route, routeReason: manifest?.routeReason ?? routePayload.reason ?? "Recovered from persisted workspace evidence",
      capabilityRefs: manifest?.capabilityRefs ?? routePayload.capabilityRefs ?? [], targetRef: manifest?.targetRef ?? routePayload.targetRef,
      idempotencyKey: `${missionId}:${work.id}:${attemptId}`, approvalRef: manifest?.approvalRef,
      sideEffects: manifest?.sideEffects ?? [], result: "succeeded",
      startedAt: manifest?.startedAt ?? routeEvent?.createdAt ?? now, endedAt: manifest?.endedAt ?? now, createdAt: now
    };
    await this.input.controller.emit(missionId, "execution.invocation.recorded", { receipt, recovered: true }, { type: "system" }, `invocation:${executionId}`);
  }

  private async markLost(missionId: string, executionId: string, work: WorkItem | undefined, reason: string): Promise<void> {
    await this.input.controller.emit(missionId, "execution.lost", { id: executionId, workItemId: work?.id, reason }, { type: "system" }, `execution-lost:${executionId}`);
    if (!work) return;
    await this.input.controller.emit(missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution lost during recovery; inspection required before retry" }, { type: "system" }, `work-recovery-wait:${work.id}:${executionId}`);
    await this.input.controller.openGap(missionId, {
      id: `recovery-${executionId}`, severity: "major", category: "runtime",
      description: `${reason}. Do not retry blindly; inspect workspace and possible side effects first.`,
      requirementRefs: work.requirementRefs, artifactRefs: work.inputArtifactRefs
    });
  }
}
EOF

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";', 'import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";\nimport { ArtifactAssurancePipeline } from "./orchestration/artifact-assurance-pipeline.ts";')
old='''      this.executionRouter = executionRouter;\n      this.recovery = new ExecutionRecoveryManager({ controller: this.controller, events: this.events, projections: this.projections, router: executionRouter });\n      this.orchestrator = new MissionOrchestrator({\n        controller: this.controller,\n        projections: this.projections,\n        hostBackend: hostAgentBackend,\n        workspaces: this.workspaces,\n        artifacts: this.artifacts,\n        verifier: new BasicFileVerifier(),'''
new='''      const verifier = new BasicFileVerifier();\n      const assurance = new ArtifactAssurancePipeline({ controller: this.controller, projections: this.projections, artifacts: this.artifacts, verifier });\n      this.executionRouter = executionRouter;\n      this.recovery = new ExecutionRecoveryManager({ controller: this.controller, events: this.events, projections: this.projections, router: executionRouter, workspaces: this.workspaces, assurance });\n      this.orchestrator = new MissionOrchestrator({\n        controller: this.controller,\n        projections: this.projections,\n        hostBackend: hostAgentBackend,\n        workspaces: this.workspaces,\n        artifacts: this.artifacts,\n        verifier,\n        assurance,'''
if old not in s: raise SystemExit('mission runtime recovery block not found')
s=s.replace(old,new)
s=s.replace('    if (!this.recovery) return { running: [], lost: [] };', '    if (!this.recovery) return { running: [], recovered: [], lost: [] };')
p.write_text(s)
PY

cat > tests/integration/recovery-by-observation.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { WORKER_RECOVERY_FILE } from "../../src/core/execution/worker-output.ts";

 test("runtime recovers verified workspace output instead of blindly retrying a lost execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-observed-recovery-"));
  const missionId = "observed-recovery";
  const attemptId = "attempt-recoverable";
  const executionId = "execution-recoverable";
  const first = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  await first.controller.createMission(missionId, "recover already completed output");
  const now = new Date().toISOString();
  await first.controller.proposeWork({ id: "work-recoverable", missionId, purpose: "production", objective: "produce report", status: "ready", requirementRefs: ["req-report"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "report", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
  await first.controller.emit(missionId, "work.started", { id: "work-recoverable" }, { type: "controller" }, "work-start-recoverable");
  await first.controller.emit(missionId, "attempt.created", { id: attemptId, workItemId: "work-recoverable", executorId: "host_agent", contextPacketId: "ctx" }, { type: "controller" }, `attempt:${attemptId}`);
  await first.controller.emit(missionId, "execution.created", { id: executionId, workItemId: "work-recoverable", attemptId }, { type: "controller" }, `execution-created:${executionId}`);
  await first.controller.emit(missionId, "execution.route.selected", { executionId, workItemId: "work-recoverable", attemptId, route: "host_agent", reason: "test recovery", capabilityRefs: [] }, { type: "controller" }, `execution-route:${executionId}`);
  await first.controller.emit(missionId, "execution.started", { id: executionId }, { type: "host" }, `execution-started:${executionId}`);
  const workspace = first.workspaces.allocate(missionId, attemptId);
  writeFileSync(join(workspace.root, "report.md"), "# completed before crash\n", "utf8");
  writeFileSync(join(workspace.root, WORKER_RECOVERY_FILE), JSON.stringify({ status: "completed", summary: "report was already completed", outputs: [{ path: "report.md", logicalName: "report", type: "document", requirementRefs: [] }], proposedFacts: [], proposedWork: [], warnings: [] }), "utf8");
  first.close();

  const recoveredRuntime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  const summary = await recoveredRuntime.recoverMission(missionId);
  assert.deepEqual(summary.recovered, [executionId]);
  assert.deepEqual(summary.lost, []);
  const state = await recoveredRuntime.controller.state(missionId);
  assert.equal(state.activeExecutionIds.includes(executionId), false);
  const artifacts = await recoveredRuntime.projections.listArtifacts(missionId);
  assert.equal(artifacts.some(artifact => artifact.logicalName === "report"), true);
  const work = (await recoveredRuntime.projections.listWorkItems(missionId)).find(item => item.id === "work-recoverable");
  assert.equal(work?.status, "succeeded");
  const gaps = await recoveredRuntime.projections.listGaps(missionId);
  assert.equal(gaps.some(gap => gap.id === `recovery-${executionId}`), false);
  const receipts = await recoveredRuntime.projections.listInvocationReceipts(missionId);
  assert.equal(receipts.some(receipt => receipt.executionId === executionId && receipt.result === "succeeded"), true);
  recoveredRuntime.close();
});
EOF

npm test
npm run smoke
git diff --check
