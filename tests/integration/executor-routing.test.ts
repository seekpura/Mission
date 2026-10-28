import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";

const tool: CapabilityDescriptor = {
  id: "host:report-tool", kind: "tool", name: "report tool", description: "render report document", hostNative: true, available: true,
  invocationRef: "report-tool", permissions: [], scope: "host", metadata: { executionMode: "direct", sideEffectClass: "read" }
};

test("orchestrator directly invokes a resolved host tool instead of spawning an agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-direct-tool-"));
  const host = new FakeHostAdapter([tool], {
    capabilityInvoker: request => {
      assert.equal(request.capabilityId, tool.id);
      assert.ok(request.workspaceRoot);
      writeFileSync(join(request.workspaceRoot!, "report.md"), "# routed directly\n", "utf8");
      return { ok: true, output: { status: "completed", summary: "direct tool complete", outputs: [{ path: "report.md", logicalName: "report", kind: "document" }], proposedFacts: [], proposedWork: [], warnings: [] } };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host });
  const missionId = "direct-tool-mission";
  await runtime.controller.createMission(missionId, "render report");
  const need: CapabilityNeed = { id: "need-report", missionId, objective: "render report", requiredFunctions: ["render report"], desiredInputs: [], desiredOutputs: ["document"], purpose: "production", urgency: "blocking", acquisitionAllowed: false, maxRisk: "low", requirementRefs: [], gapRefs: [], status: "checking-installed" };
  await runtime.controller.emit(missionId, "capability.need.created", { need }, { type: "planner" }, `need:${need.id}`);
  const now = new Date().toISOString();
  await runtime.controller.proposeWork({ id: "work-report", missionId, purpose: "production", objective: "render report", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "report", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [need.id], priority: 10, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  assert.equal(host.agentRequests.length, 0);
  assert.equal(host.capabilityInvocations.length, 1);
  const artifacts = await runtime.projections.listArtifacts(missionId);
  assert.ok(artifacts.some(artifact => artifact.logicalName === "report"));
  runtime.close();
});
