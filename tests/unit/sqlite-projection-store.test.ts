import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections });
  return { db, projections, events, controller };
}

test("event append atomically maintains durable mission, work and gap projections", async () => {
  const { db, projections, controller } = setup();
  await controller.createMission("m-projection", "ship a verified artifact");
  const now = new Date().toISOString();
  const work: WorkItem = {
    id: "w1", missionId: "m-projection", purpose: "exploration", objective: "inspect the problem",
    status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 70, graphRevision: 1,
    createdBy: "planner", createdAt: now, updatedAt: now
  };
  await controller.proposeWork(work);
  await controller.openGap("m-projection", { id: "g1", severity: "major", description: "missing evidence", category: "evidence" });

  const state = await projections.getMissionState("m-projection");
  assert.ok(state);
  assert.equal(state.lastEventSequence, 5);
  assert.deepEqual(state.readyWorkItemIds, ["w1"]);
  assert.deepEqual(state.blockingGapIds, ["g1"]);
  assert.equal((await projections.listWorkItems("m-projection"))[0]?.objective, "inspect the problem");
  assert.equal((await projections.listGaps("m-projection"))[0]?.category, "evidence");
  db.close();
});

test("projection rebuild reproduces current mission state from the event log", async () => {
  const { db, projections, events, controller } = setup();
  await controller.createMission("m-rebuild", "recover after projection loss");
  await controller.openGap("m-rebuild", { id: "g1", severity: "major", description: "repair me" });
  const before = await projections.getMissionState("m-rebuild");
  assert.ok(before);

  db.db.prepare("DELETE FROM mission_states WHERE mission_id = ?").run("m-rebuild");
  db.db.prepare("DELETE FROM gaps WHERE mission_id = ?").run("m-rebuild");
  projections.rebuild("m-rebuild", await events.list("m-rebuild"));

  const after = await projections.getMissionState("m-rebuild");
  assert.deepEqual(after, before);
  assert.equal((await projections.listGaps("m-rebuild")).length, 1);
  db.close();
});
