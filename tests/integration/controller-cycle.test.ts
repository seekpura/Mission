import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function setup(deliberation: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  return { db, events, projections, controller: new MissionController(events, { projections, deliberation }) };
}

function scriptedProvider(): DeliberationProvider {
  return {
    async composeStrategy() {
      return { framing: "mission specific", approach: "progressive", workstreams: [{ id: "core", objective: "produce the artifact" }], revision: 1 };
    },
    async planFrontier({ state }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        workItems: [{
          id: "w-produce", missionId: state.missionId, workstreamId: "core", purpose: "exploration", objective: "produce first evidence-backed artifact",
          status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [],
          priority: 80, graphRevision: state.graphRevision + 1, createdBy: "planner", createdAt: now, updatedAt: now
        }]
      };
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "upstream artifact is incomplete", intervention: "revise_work", confidence: 0.9 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 0.95 };
    }
  };
}

test("controller cycle composes strategy, opens a rolling frontier and can complete after verified work", async () => {
  const { db, events, controller } = setup(scriptedProvider());
  await controller.createMission("m-cycle", "deliver one verified artifact");
  const first = await controller.runControllerCycle({ missionId: "m-cycle", trigger: "mission_created" });
  assert.deepEqual(first.workItemsCreated, ["w-produce"]);
  let state = await controller.state("m-cycle");
  assert.equal(state.strategyRevision, 1);
  assert.deepEqual(state.readyWorkItemIds, ["w-produce"]);

  await controller.emit("m-cycle", "work.completed", { id: "w-produce" }, { type: "worker" });
  await controller.validateArtifact("m-cycle", "artifact-main@1", true);
  const done = await controller.runControllerCycle({ missionId: "m-cycle", trigger: "verification_event" });
  assert.equal(done.status, "completed");
  state = await controller.state("m-cycle");
  assert.equal(state.status, "completed");
  assert.ok((await events.list("m-cycle")).some(event => event.type === "mission.completed"));
  db.close();
});

test("controller diagnoses a blocking gap and materializes a repair work item", async () => {
  const { db, controller, projections } = setup(scriptedProvider());
  await controller.createMission("m-gap-cycle", "repair a production artifact");
  await controller.openGap("m-gap-cycle", { id: "g-broken", severity: "major", description: "artifact is structurally broken" });
  const cycle = await controller.runControllerCycle({ missionId: "m-gap-cycle", trigger: "verification_event" });
  assert.equal(cycle.decisionsCreated.length, 1);
  assert.deepEqual(cycle.workItemsCreated, ["repair-g-broken"]);
  const repair = (await projections.listWorkItems("m-gap-cycle")).find(work => work.id === "repair-g-broken");
  assert.ok(repair);
  assert.equal(repair.purpose, "repair");
  assert.deepEqual(repair.gapRefs, ["g-broken"]);
  db.close();
});
