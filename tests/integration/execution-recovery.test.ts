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
  await first.controller.proposeWork({ id: "work-1", missionId, purpose: "production", objective: "produce required output", status: "ready", requirementRefs: ["req-recovery-output"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
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
