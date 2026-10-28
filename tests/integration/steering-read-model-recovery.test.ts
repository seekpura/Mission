import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

test("durable steering survives projection loss and rebuilds from Mission events in sequence order", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events, undefined, undefined, undefined, undefined, reader);
  const missionId = "mission-steering-rebuild";

  try {
    await controller.createMission(missionId, "Create a technology keynote");
    await controller.steer(missionId, "Make the keynote more technical and less promotional.");
    await controller.steer(missionId, "Preserve source traceability and editable deliverables.");

    const before = await reader.journal(missionId);
    assert.deepEqual(before.steeringMessages.map(item => item.message), [
      "Make the keynote more technical and less promotional.",
      "Preserve source traceability and editable deliverables."
    ]);
    assert.ok(before.steeringMessages[1]!.sequence > before.steeringMessages[0]!.sequence);

    database.db.prepare("DELETE FROM rm_steering_messages WHERE mission_id = ?").run(missionId);
    database.db.prepare(
      "DELETE FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).run("mission-steering-read-model-v1", missionId);
    assert.deepEqual((await reader.journal(missionId)).steeringMessages, []);

    // A fresh EventStore startup owns projector catch-up and must restore the
    // lost read model from the append-only Mission log without user replay.
    new SqliteEventStore(database);
    const rebuilt = await reader.journal(missionId);
    assert.deepEqual(rebuilt.steeringMessages, before.steeringMessages);

    const sequenceBeforeRejectedInput = await events.lastSequence(missionId);
    await assert.rejects(() => controller.steer(missionId, "   "), /must be non-empty/);
    await assert.rejects(() => controller.steer(missionId, "x".repeat(64 * 1024 + 1)), /exceeds 65536 characters/);
    assert.equal(await events.lastSequence(missionId), sequenceBeforeRejectedInput);
  } finally {
    database.close();
  }
});
