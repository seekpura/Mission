import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionHistoryReader } from "../../src/persistence/sqlite/sqlite-mission-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const event = await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "history-export-fixture" },
    payload: { message: id },
    schemaVersion: 1,
    createdAt: new Date(1_800_000_000_000 + expected * 1000).toISOString()
  }, expected);
  return event.sequence;
}

test("Mission history export freezes a bounded prefix while live history continues", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteMissionHistoryReader(database);
  const missionId = "mission-history-export";

  try {
    await controller.createMission(missionId, "export a stable Mission history prefix");
    await appendSteering(events, missionId, "steering-4");
    await appendSteering(events, missionId, "steering-5");
    assert.equal(await events.lastSequence(missionId), 5);

    const first = reader.readExportPage(missionId, { limit: 2 });
    assert.ok(first);
    assert.equal(first.format, "mission-events/v1");
    assert.equal(first.throughSequence, 5);
    assert.equal(first.latestSequenceAtRead, 5);
    assert.deepEqual(first.events.map(event => event.sequence), [1, 2]);
    assert.equal(first.complete, false);
    assert.equal(first.nextAfterSequence, 2);

    await appendSteering(events, missionId, "steering-6-live-tail");
    assert.equal(await events.lastSequence(missionId), 6);

    const second = reader.readExportPage(missionId, {
      afterSequence: first.nextAfterSequence,
      throughSequence: first.throughSequence,
      limit: 2
    });
    assert.ok(second);
    assert.equal(second.throughSequence, 5);
    assert.equal(second.latestSequenceAtRead, 6);
    assert.deepEqual(second.events.map(event => event.sequence), [3, 4]);
    assert.equal(second.nextAfterSequence, 4);

    const third = reader.readExportPage(missionId, {
      afterSequence: second.nextAfterSequence,
      throughSequence: first.throughSequence,
      limit: 2
    });
    assert.ok(third);
    assert.deepEqual(third.events.map(event => event.sequence), [5]);
    assert.equal(third.complete, true);
    assert.equal(third.nextAfterSequence, undefined);

    const exported = [...first.events, ...second.events, ...third.events];
    assert.deepEqual(exported.map(event => event.sequence), [1, 2, 3, 4, 5]);
    assert.equal(new Set(exported.map(event => event.id)).size, exported.length);

    const futureBound = reader.readExportPage(missionId, { throughSequence: 999, limit: 5000 });
    assert.ok(futureBound);
    assert.equal(futureBound.throughSequence, 6);
    assert.equal(futureBound.complete, true);
    assert.deepEqual(futureBound.events.map(event => event.sequence), [1, 2, 3, 4, 5, 6]);

    database.db.prepare(`
      INSERT INTO snapshots (id, mission_id, event_sequence, state_json, created_at)
      VALUES ('history-snapshot', ?, 4, '{}', '2026-10-29T12:00:00.000Z')
    `).run(missionId);
    const retention = reader.readRetentionState(missionId);
    assert.ok(retention);
    assert.equal(retention.policy, "full-history-required");
    assert.equal(retention.latestSequence, 6);
    assert.equal(retention.oldestRetainedSequence, 1);
    assert.equal(retention.retainedEventCount, 6);
    assert.equal(retention.fullHistoryPresent, true);
    assert.equal(retention.latestSnapshotSequence, 4);
    assert.ok(retention.maximumProjectionCheckpointSequence > 0);
    assert.equal(retention.deletionEligibleThroughSequence, 0);
    assert.match(retention.reason, /do not authorize deletion/);

    database.db.prepare("DELETE FROM mission_events WHERE mission_id = ? AND sequence = 4").run(missionId);
    assert.throws(
      () => reader.readExportPage(missionId, { afterSequence: 2, throughSequence: 6, limit: 10 }),
      /sequence gap.*expected 4, found 5/
    );
    const damaged = reader.readRetentionState(missionId);
    assert.ok(damaged);
    assert.equal(damaged.fullHistoryPresent, false);
    assert.equal(damaged.deletionEligibleThroughSequence, 0);

    assert.equal(reader.readExportPage("missing-mission"), undefined);
    assert.equal(reader.readRetentionState("missing-mission"), undefined);
    assert.throws(() => reader.readExportPage(missionId, { limit: 5001 }), /between 1 and 5000/);
    assert.throws(() => reader.readExportPage(missionId, { afterSequence: -1 }), /non-negative safe integer/);
  } finally {
    database.close();
  }
});
