import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const store = new SqliteEventStore(db);
  return { db, store };
}

test("controller reconstructs mission after controller replacement and preserves repair state", async () => {
  const { db, store } = setup();
  const a = new MissionController(store);
  await a.createMission("m-recover", "build a production artifact");
  await a.openGap("m-recover", { id: "g-overflow", severity: "major", description: "layout overflow" });
  const b = new MissionController(store);
  const recovered = await b.state("m-recover");
  assert.deepEqual(recovered.blockingGapIds, ["g-overflow"]);
  await b.resolveGap("m-recover", "g-overflow");
  await b.validateArtifact("m-recover", "deck@2", true);
  const done = await b.completeIfEligible("m-recover");
  assert.equal(done.status, "completed");
  db.close();
});
