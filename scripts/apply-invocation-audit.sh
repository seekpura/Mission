#!/usr/bin/env bash
set -euo pipefail

cat > src/core/domain/invocation.ts <<'EOF'
import type { ExecutionResult, SideEffectRecord } from "./execution.ts";

export type InvocationRoute = "host_agent" | "host_capability" | "local_cli";

export interface InvocationReceipt {
  id: string;
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  route: InvocationRoute;
  routeReason: string;
  capabilityRefs: string[];
  targetRef?: string;
  idempotencyKey?: string;
  approvalRef?: string;
  sideEffects: SideEffectRecord[];
  result: ExecutionResult["state"];
  startedAt: string;
  endedAt: string;
  createdAt: string;
}
EOF

python - <<'PY'
from pathlib import Path

p=Path('src/core/domain/event.ts')
s=p.read_text()
s=s.replace('  | "execution.started"\n  | "execution.completed"', '  | "execution.started"\n  | "execution.route.selected"\n  | "execution.invocation.recorded"\n  | "execution.completed"')
p.write_text(s)

p=Path('src/core/events/projection-store.ts')
s=p.read_text()
s=s.replace('import type { MissionEvent } from "../domain/event.ts";', 'import type { MissionEvent } from "../domain/event.ts";\nimport type { InvocationReceipt } from "../domain/invocation.ts";')
s=s.replace('  listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]>;\n', '  listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]>;\n  listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]>;\n')
p.write_text(s)

p=Path('src/persistence/sqlite/schema.sql')
s=p.read_text()
block='''\n\nCREATE TABLE IF NOT EXISTS invocation_receipts (\n  id TEXT PRIMARY KEY,\n  mission_id TEXT NOT NULL,\n  work_item_id TEXT NOT NULL,\n  execution_id TEXT NOT NULL,\n  route TEXT NOT NULL,\n  result TEXT NOT NULL,\n  data_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_invocation_receipts_mission ON invocation_receipts(mission_id, created_at);'''
if 'CREATE TABLE IF NOT EXISTS invocation_receipts' not in s:
    s += block + '\n'
p.write_text(s)

p=Path('src/persistence/sqlite/sqlite-entity-projector.ts')
s=p.read_text()
s=s.replace('import type { MissionEvent } from "../../core/domain/event.ts";', 'import type { MissionEvent } from "../../core/domain/event.ts";\nimport type { InvocationReceipt } from "../../core/domain/invocation.ts";')
marker='''      case "capability.need.created": {'''
insert='''      case "execution.invocation.recorded": {\n        const receipt = (payload.receipt ?? payload) as InvocationReceipt;\n        if (!receipt?.id) return;\n        db.prepare(`INSERT OR REPLACE INTO invocation_receipts\n          (id, mission_id, work_item_id, execution_id, route, result, data_json, created_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?, ?)` )\n          .run(receipt.id, event.missionId, receipt.workItemId, receipt.executionId, receipt.route, receipt.result, JSON.stringify(receipt), receipt.createdAt ?? event.createdAt);\n        return;\n      }\n'''
if marker not in s: raise SystemExit('entity projector insertion marker not found')
s=s.replace(marker, insert+marker)
p.write_text(s)

p=Path('src/persistence/sqlite/sqlite-projection-store.ts')
s=p.read_text()
s=s.replace('import type { MissionEvent } from "../../core/domain/event.ts";', 'import type { MissionEvent } from "../../core/domain/event.ts";\nimport type { InvocationReceipt } from "../../core/domain/invocation.ts";')
s=s.replace('    db.prepare("DELETE FROM acquisition_receipts WHERE mission_id = ?").run(missionId);', '    db.prepare("DELETE FROM acquisition_receipts WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM invocation_receipts WHERE mission_id = ?").run(missionId);')
marker='''  async listVerificationResults(missionId: string): Promise<VerificationResult[]> {'''
method='''  async listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM invocation_receipts WHERE mission_id = ? ORDER BY created_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as InvocationReceipt);\n  }\n\n'''
if marker not in s: raise SystemExit('projection method marker not found')
s=s.replace(marker, method+marker)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/executor-router.ts')
s=p.read_text()

s=s.replace('export interface RoutedExecutionInput {\n  work: WorkItem;', 'export interface RoutedExecutionInput {\n  work: WorkItem;\n  route?: ExecutionRoute;')
s=s.replace('export interface RoutedExecutionResult {\n  route: ExecutionRoute;\n  result: ExecutionResult;\n}', 'export interface RoutedExecutionResult {\n  route: ExecutionRoute;\n  result: ExecutionResult;\n  approvalRef?: string;\n}\n\nexport interface ExecutionAuditObserver {\n  approvalRequested?(payload: { id: string; missionId: string; workItemId: string; executionId: string; scope: "once"; capabilityId?: string; route: ExecutionRouteKind }): Promise<void> | void;\n  approvalDecided?(payload: { id: string; missionId: string; workItemId: string; executionId: string; approved: boolean; scope?: "once" | "mission" | "revision" | "host" }): Promise<void> | void;\n}')
s=s.replace('  private readonly artifactLeases: ArtifactLeaseManager;', '  private readonly artifactLeases: ArtifactLeaseManager;\n  private readonly audit?: ExecutionAuditObserver;')
s=s.replace('    artifactLeases?: ArtifactLeaseManager;\n  }) {', '    artifactLeases?: ArtifactLeaseManager;\n    audit?: ExecutionAuditObserver;\n  }) {')
s=s.replace('    this.artifactLeases = input.artifactLeases ?? new ArtifactLeaseManager();', '    this.artifactLeases = input.artifactLeases ?? new ArtifactLeaseManager();\n    this.audit = input.audit;')
old='''  async execute(input: RoutedExecutionInput): Promise<RoutedExecutionResult> {\n    const route = this.select(input.work, input.capabilities);\n    const ownerId = input.baseRequest.executionId;\n    const resourceLease = await this.resources.acquire(ownerId, route.resourceRequest.exclusiveResources ?? []);\n    const artifactLease = await this.artifactLeases.acquireWrite(ownerId, input.work.expectedOutputs.map(output => output.logicalName));\n    try {\n      if (route.requiresApproval) {\n        const approval = await this.host.requestUserApproval({\n          missionId: input.work.missionId,\n          title: `Allow ${route.capability?.name ?? route.kind}`,\n          reason: `Execution may perform ${String(route.capability?.metadata?.sideEffectClass ?? "external")} side effects`,\n          details: { workItemId: input.work.id, capabilityId: route.capability?.id, route: route.kind }\n        });\n        if (!approval.approved) throw new Error(`Execution approval denied for ${route.capability?.id ?? route.kind}`);\n        route.sideEffectPolicy = approvedPolicy(route.sideEffectPolicy);\n      }\n      if (route.kind === "host_capability") return { route, result: await this.executeHostCapability(input, route) };\n      if (route.kind === "local_cli") return { route, result: await this.executeLocalCli(input, route) };\n      return { route, result: await this.executeAgent(input) };\n    } finally {\n      artifactLease.release();\n      resourceLease.release();\n    }\n  }'''
new='''  async execute(input: RoutedExecutionInput): Promise<RoutedExecutionResult> {\n    const route = input.route ?? this.select(input.work, input.capabilities);\n    const ownerId = input.baseRequest.executionId;\n    const resourceLease = await this.resources.acquire(ownerId, route.resourceRequest.exclusiveResources ?? []);\n    const artifactLease = await this.artifactLeases.acquireWrite(ownerId, input.work.expectedOutputs.map(output => output.logicalName));\n    let approvalRef: string | undefined;\n    try {\n      if (route.requiresApproval) {\n        approvalRef = `approval-execution-${input.baseRequest.executionId}`;\n        await this.audit?.approvalRequested?.({\n          id: approvalRef, missionId: input.work.missionId, workItemId: input.work.id, executionId: input.baseRequest.executionId, scope: "once", capabilityId: route.capability?.id, route: route.kind\n        });\n        const approval = await this.host.requestUserApproval({\n          missionId: input.work.missionId,\n          title: `Allow ${route.capability?.name ?? route.kind}`,\n          reason: `Execution may perform ${String(route.capability?.metadata?.sideEffectClass ?? "external")} side effects`,\n          details: { approvalId: approvalRef, workItemId: input.work.id, capabilityId: route.capability?.id, route: route.kind }\n        });\n        await this.audit?.approvalDecided?.({\n          id: approvalRef, missionId: input.work.missionId, workItemId: input.work.id, executionId: input.baseRequest.executionId, approved: approval.approved, scope: approval.scope\n        });\n        if (!approval.approved) throw new Error(`Execution approval denied for ${route.capability?.id ?? route.kind}`);\n        route.sideEffectPolicy = approvedPolicy(route.sideEffectPolicy);\n      }\n      const result = route.kind === "host_capability"\n        ? await this.executeHostCapability(input, route)\n        : route.kind === "local_cli"\n          ? await this.executeLocalCli(input, route)\n          : await this.executeAgent(input);\n      return { route, result, approvalRef };\n    } finally {\n      artifactLease.release();\n      resourceLease.release();\n    }\n  }'''
if old not in s: raise SystemExit('router execute block not found')
s=s.replace(old,new)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
old='''      const executionRouter = new WorkExecutionRouter({\n        host: options.host,\n        agents: hostAgentBackend,\n        hostCapabilities: new HostCapabilityExecutionBackend(options.host),\n        local: new LocalExecutionBackend(this.workspaces, this.artifacts)\n      });'''
new='''      const executionRouter = new WorkExecutionRouter({\n        host: options.host,\n        agents: hostAgentBackend,\n        hostCapabilities: new HostCapabilityExecutionBackend(options.host),\n        local: new LocalExecutionBackend(this.workspaces, this.artifacts),\n        audit: {\n          approvalRequested: payload => this.controller.emit(payload.missionId, "approval.requested", payload, { type: "controller" }, `approval-request:${payload.id}`),\n          approvalDecided: payload => this.controller.emit(payload.missionId, "approval.decided", payload, { type: "user" }, `approval-decision:${payload.id}`)\n        }\n      });'''
if old not in s: raise SystemExit('runtime router block not found')
s=s.replace(old,new)
p.write_text(s)
PY

python - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()
s=s.replace('import type { WorkExecutionRouter, ExecutionRoute } from "./executor-router.ts";', 'import type { WorkExecutionRouter, ExecutionRoute } from "./executor-router.ts";\nimport type { InvocationReceipt } from "../../core/domain/invocation.ts";')
s=s.replace('    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, executorType: selectedRoute.kind, routeReason: selectedRoute.reason }, { type: "controller" }, `execution-created:${executionId}`);', '    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, executorType: selectedRoute.kind, routeReason: selectedRoute.reason }, { type: "controller" }, `execution-created:${executionId}`);\n    await this.controller.emit(work.missionId, "execution.route.selected", { executionId, workItemId: work.id, attemptId, route: selectedRoute.kind, reason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id), targetRef: selectedRoute.capability?.id }, { type: "controller" }, `execution-route:${executionId}`);')
old='''      let result;\n      if (this.executionRouter) {\n        const routed = await this.executionRouter.execute({ work, capabilities, baseRequest: request });\n        result = routed.result;\n      } else {\n        const handle = await this.hostBackend.allocate(request);\n        await this.hostBackend.start(handle);\n        result = await this.hostBackend.collect(handle);\n      }\n      await this.controller.emit(work.missionId, result.state === "succeeded" ? "execution.completed" : "execution.failed", { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);'''
new='''      let result;\n      let approvalRef: string | undefined;\n      if (this.executionRouter) {\n        const routed = await this.executionRouter.execute({ work, capabilities, baseRequest: request, route: selectedRoute });\n        result = routed.result;\n        approvalRef = routed.approvalRef;\n      } else {\n        const handle = await this.hostBackend.allocate(request);\n        await this.hostBackend.start(handle);\n        result = await this.hostBackend.collect(handle);\n      }\n      const receipt: InvocationReceipt = {\n        id: `invocation-${executionId}`,\n        missionId: work.missionId, workItemId: work.id, attemptId, executionId,\n        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),\n        targetRef: selectedRoute.capability?.id, idempotencyKey: `${work.missionId}:${work.id}:${attemptId}`, approvalRef,\n        sideEffects: result.sideEffects, result: result.state, startedAt: result.startedAt, endedAt: result.endedAt, createdAt: new Date().toISOString()\n      };\n      await this.controller.emit(work.missionId, "execution.invocation.recorded", { receipt }, { type: "system" }, `invocation:${executionId}`);\n      await this.controller.emit(work.missionId, result.state === "succeeded" ? "execution.completed" : "execution.failed", { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);'''
if old not in s: raise SystemExit('orchestrator routed result block not found')
s=s.replace(old,new)
p.write_text(s)
PY

cat > tests/integration/invocation-audit.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";

const writer: CapabilityDescriptor = {
  id: "host:writer", kind: "tool", name: "writer", description: "write external report", hostNative: true, available: true,
  invocationRef: "writer", permissions: ["external-write"], scope: "host", metadata: { executionMode: "direct", sideEffectClass: "reversible-write" }
};

test("direct invocation persists route, approval and side-effect audit across projection rebuild", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-invocation-audit-"));
  const host = new FakeHostAdapter([writer], {
    capabilityInvoker: request => {
      writeFileSync(join(request.workspaceRoot!, "report.md"), "# audited\n", "utf8");
      return {
        ok: true,
        output: { status: "completed", summary: "audited direct tool", outputs: [{ path: "report.md", logicalName: "report", kind: "document" }], proposedFacts: [], proposedWork: [], warnings: [] },
        sideEffects: [{ type: "external-write", target: "fake://report", reversible: true, result: "written" }]
      };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host });
  const missionId = "invocation-audit-mission";
  await runtime.controller.createMission(missionId, "write report");
  const need: CapabilityNeed = { id: "need-writer", missionId, objective: "write report", requiredFunctions: ["write report"], desiredInputs: [], desiredOutputs: ["document"], purpose: "production", urgency: "blocking", acquisitionAllowed: false, maxRisk: "low", requirementRefs: [], gapRefs: [], status: "checking-installed" };
  await runtime.controller.emit(missionId, "capability.need.created", { need }, { type: "planner" }, `need:${need.id}`);
  const now = new Date().toISOString();
  await runtime.controller.proposeWork({ id: "work-writer", missionId, purpose: "production", objective: "write report", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "report", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [need.id], priority: 10, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  const events = await runtime.events.list(missionId);
  assert.ok(events.some(event => event.type === "execution.route.selected"));
  assert.ok(events.some(event => event.type === "approval.requested"));
  assert.ok(events.some(event => event.type === "approval.decided"));
  assert.ok(events.some(event => event.type === "execution.invocation.recorded"));

  let receipts = await runtime.projections.listInvocationReceipts(missionId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.route, "host_capability");
  assert.equal(receipts[0]!.targetRef, writer.id);
  assert.ok(receipts[0]!.approvalRef?.startsWith("approval-execution-"));
  assert.equal(receipts[0]!.sideEffects[0]?.type, "external-write");
  assert.equal(receipts[0]!.result, "succeeded");

  await runtime.rebuildProjection(missionId);
  receipts = await runtime.projections.listInvocationReceipts(missionId);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]!.routeReason.includes("directly"), true);
  runtime.close();
});
EOF

npm test
npm run smoke
git diff --check
