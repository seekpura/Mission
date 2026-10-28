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
