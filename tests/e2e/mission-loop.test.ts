import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

test("mission can move through blocking verification gap, targeted repair, verified final and completion", async () => {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const store = new SqliteEventStore(db);
  const controller = new MissionController(store);
  await controller.createMission("mission-e2e", "produce a high-quality deliverable");
  await controller.openGap("mission-e2e", { id: "gap-1", severity: "major", description: "candidate artifact failed quality verification" });
  let state = await controller.runControllerCycle({ missionId: "mission-e2e", trigger: "verification_event" });
  assert.equal(state.status, "active");
  await controller.resolveGap("mission-e2e", "gap-1");
  await controller.validateArtifact("mission-e2e", "deliverable@2", true);
  state = await controller.runControllerCycle({ missionId: "mission-e2e", trigger: "verification_event" });
  assert.equal(state.status, "completed");
  const eventTypes = (await store.list("mission-e2e")).map(e => e.type);
  assert.ok(eventTypes.includes("gap.opened"));
  assert.ok(eventTypes.includes("gap.resolved"));
  assert.ok(eventTypes.includes("artifact.validated"));
  assert.ok(eventTypes.includes("mission.completed"));
  db.close();
});
