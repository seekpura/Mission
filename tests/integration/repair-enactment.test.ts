import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { WorkExecutionRouter } from "../../src/runtime/orchestration/executor-router.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../../src/execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup(intervention: "replace_capability" | "replace_executor") {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "repair", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "the selected execution path repeatedly fails semantically", intervention, confidence: 0.93, repairScope: intervention === "replace_capability" ? "capability" : "executor" };
    },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  return { db, projections, events, controller: new MissionController(events, { projections, deliberation }) };
}

async function seedBrokenWork(controller: MissionController, missionId: string) {
  await controller.createMission(missionId, "repair the failed artifact");
  const now = new Date().toISOString();
  const work: WorkItem = {
    id: "w-broken", missionId, purpose: "production", objective: "produce artifact", status: "failed",
    requirementRefs: ["r1"], gapRefs: ["g1"], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: ["need-old"],
    priority: 80, graphRevision: 0, createdBy: "planner", createdAt: now, updatedAt: now
  };
  await controller.proposeWork(work);
  await controller.emit(missionId, "capability.need.created", { need: {
    id: "need-old", missionId, objective: "render artifact", requiredFunctions: ["render artifact"], desiredInputs: [], desiredOutputs: [],
    purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: ["r1"], gapRefs: ["g1"],
    status: "available", resolvedCapabilityRef: "cap-old"
  } }, { type: "planner" });
  await controller.emit(missionId, "capability.activated", { needId: "need-old", capability: {
    id: "cap-old", kind: "tool", name: "Old Renderer", description: "render artifact", hostNative: true, available: true,
    invocationRef: "old.render", permissions: [], scope: "mission"
  } }, { type: "system" });
  await controller.emit(missionId, "execution.invocation.recorded", { receipt: {
    id: "inv-old", missionId, workItemId: "w-broken", attemptId: "a-old", executionId: "e-old", route: "host_capability",
    routeReason: "old route", capabilityRefs: ["cap-old"], targetRef: "cap-old", sideEffects: [], result: "failed",
    startedAt: now, endedAt: now, createdAt: now
  } }, { type: "system" });
  await controller.recordEvidence(missionId, {
    id: "ev-route", missionId, subjectRef: "cap-old", type: "runtime-check",
    claim: "The selected capability produced a semantically invalid result", result: "contradicts", producedBy: "runtime", createdAt: now
  });
  await controller.emit(missionId, "finding.created", { finding: {
    id: "f-route", missionId, category: "technical", severity: "major", observation: "The same execution path failed the required semantic contract",
    expected: "A valid artifact from a working execution path", requirementRefs: ["r1"], evidenceRefs: ["ev-route"], confidence: 0.95, reproducible: true, createdAt: now
  } }, { type: "verifier" });
  await controller.openGap(missionId, { id: "g1", severity: "major", description: "renderer output is invalid", requirementRefs: ["r1"], findingRefs: ["f-route"] });
}

test("replace_capability invalidates the old capability and creates a replacement need wired to repair work", async () => {
  const { db, controller, projections } = setup("replace_capability");
  await seedBrokenWork(controller, "m-cap-replace");
  const cycle = await controller.runControllerCycle({ missionId: "m-cap-replace", trigger: "verification_event" });
  assert.deepEqual(cycle.workItemsCreated, ["repair-g1"]);
  const old = (await projections.listCapabilities("m-cap-replace")).find(cap => cap.id === "cap-old");
  assert.equal(old?.available, false);
  const replacement = (await projections.listCapabilityNeeds("m-cap-replace")).find(need => need.replacesCapabilityRef === "cap-old");
  assert.ok(replacement);
  const repair = (await projections.listWorkItems("m-cap-replace")).find(work => work.id === "repair-g1");
  assert.deepEqual(repair?.capabilityNeedRefs, [replacement!.id]);
  assert.deepEqual(repair?.executionConstraints?.excludeCapabilityRefs, ["cap-old"]);
  const events = await (controller as any).store.list("m-cap-replace");
  assert.ok(events.some((event: any) => event.type === "decision.applied"));
  db.close();
});

test("replace_executor makes the next repair prefer a different route when one is available", async () => {
  const { db, controller, projections } = setup("replace_executor");
  await seedBrokenWork(controller, "m-executor-replace");
  await controller.runControllerCycle({ missionId: "m-executor-replace", trigger: "verification_event" });
  const repair = (await projections.listWorkItems("m-executor-replace")).find(work => work.id === "repair-g1")!;
  assert.equal(repair.executionConstraints?.forceFreshAgent, true);
  assert.deepEqual(repair.executionConstraints?.avoidRouteKinds, ["host_capability"]);
  const host = new FakeHostAdapter();
  const router = new WorkExecutionRouter({
    host,
    agents: new HostAgentExecutionBackend(host),
    hostCapabilities: new HostCapabilityExecutionBackend(host),
    local: new LocalExecutionBackend(new ProcessManager())
  });
  const route = router.select(repair, [{
    id: "cap-new", kind: "tool", name: "New Renderer", description: "render artifact", hostNative: true, available: true,
    invocationRef: "new.render", permissions: [], scope: "mission"
  }]);
  assert.equal(route.kind, "host_agent");
  db.close();
});
