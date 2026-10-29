import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function listen(server: ReturnType<typeof createMissionApi>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createMissionApi>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

async function appendSteering(events: SqliteEventStore, missionId: string, message: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const committed = await events.append({
    id: `history-event-${expected + 1}`,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "history-fixture" },
    payload: { message },
    schemaVersion: 1,
    createdAt: new Date(1_800_100_000_000 + expected * 1_000).toISOString()
  }, expected);
  return committed.sequence;
}

test("history export freezes a durable upper bound and excludes later live-tail events", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-history-export";

  try {
    await controller.createMission(missionId, "export a stable Mission prefix");
    for (let index = 0; index < 5; index += 1) {
      await appendSteering(events, missionId, `note-${index}`);
    }

    const first = reader.readExportPage(missionId, { limit: 2 });
    assert.ok(first);
    assert.equal(first.format, "mission-events/v1");
    assert.equal(first.events.length, 2);
    assert.equal(first.complete, false);
    assert.equal(first.nextAfterSequence, first.events.at(-1)?.sequence);
    const frozenThrough = first.throughSequence;
    assert.equal(frozenThrough, first.latestSequenceAtRead);

    const liveTailSequence = await appendSteering(events, missionId, "arrived-after-export-started");
    assert.equal(liveTailSequence, frozenThrough + 1);

    const exported = [...first.events];
    let after = first.nextAfterSequence ?? 0;
    while (after < frozenThrough) {
      const page = reader.readExportPage(missionId, {
        afterSequence: after,
        throughSequence: frozenThrough,
        limit: 2
      });
      assert.ok(page);
      assert.equal(page.throughSequence, frozenThrough);
      assert.equal(page.latestSequenceAtRead, liveTailSequence);
      exported.push(...page.events);
      if (page.complete) break;
      assert.equal(typeof page.nextAfterSequence, "number");
      after = page.nextAfterSequence as number;
    }

    assert.deepEqual(exported.map(event => event.sequence),
      Array.from({ length: frozenThrough }, (_, index) => index + 1));
    assert.equal(new Set(exported.map(event => event.sequence)).size, frozenThrough);
    assert.equal(exported.some(event => event.sequence === liveTailSequence), false);

    const futureBound = reader.readExportPage(missionId, {
      throughSequence: Number.MAX_SAFE_INTEGER,
      limit: 5000
    });
    assert.ok(futureBound);
    assert.equal(futureBound.throughSequence, liveTailSequence);
    assert.equal(futureBound.latestSequenceAtRead, liveTailSequence);
    assert.equal(futureBound.complete, true);

    assert.throws(() => reader.readExportPage(missionId, { limit: 5001 }), /between 1 and 5000/);
    assert.throws(() => reader.readExportPage(missionId, { afterSequence: -1 }), /non-negative safe integer/);
  } finally {
    database.close();
  }
});

test("history export fails closed on an event-sequence gap", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-history-gap";

  try {
    await controller.createMission(missionId, "detect corrupt history");
    await appendSteering(events, missionId, "extra event");
    const through = await events.lastSequence(missionId);
    database.db.prepare(
      "DELETE FROM mission_events WHERE mission_id = ? AND sequence = 2"
    ).run(missionId);

    assert.throws(
      () => reader.readExportPage(missionId, { throughSequence: through, limit: 5000 }),
      /sequence gap/
    );
  } finally {
    database.close();
  }
});

test("retention state reports snapshots/checkpoints as diagnostics but never deletion authority", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-history-retention";

  try {
    await controller.createMission(missionId, "retain authoritative Mission history");
    const latest = await events.lastSequence(missionId);
    database.db.prepare(`
      INSERT INTO snapshots (id, mission_id, event_sequence, state_json, created_at)
      VALUES ('retention-snapshot', ?, ?, '{}', '2026-10-29T10:00:00.000Z')
    `).run(missionId, latest);

    const retention = reader.readRetentionState(missionId);
    assert.ok(retention);
    assert.equal(retention.mode, "full-history");
    assert.equal(retention.latestSequence, latest);
    assert.equal(retention.latestSnapshotSequence, latest);
    assert.ok(retention.projectionCheckpoints.length > 0);
    assert.equal(retention.deletionEligibleThroughSequence, 0);
    assert.match(retention.deletionReason, /do not authorize event deletion/);
  } finally {
    database.close();
  }
});

test("history API exposes bounded export/retention and fails closed without its reader", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-history-api";
  const server = createMissionApi(controller, events, { historyReader: reader });

  try {
    await controller.createMission(missionId, "query Mission history safely");
    const base = await listen(server);

    const exported = await fetch(`${base}/missions/${missionId}/history/export?limit=1`);
    assert.equal(exported.status, 200);
    const page = await exported.json() as { format: string; events: unknown[]; throughSequence: number };
    assert.equal(page.format, "mission-events/v1");
    assert.equal(page.events.length, 1);
    assert.ok(page.throughSequence >= 1);

    const retention = await fetch(`${base}/missions/${missionId}/history/retention`);
    assert.equal(retention.status, 200);
    const retentionBody = await retention.json() as { mode: string; deletionEligibleThroughSequence: number };
    assert.equal(retentionBody.mode, "full-history");
    assert.equal(retentionBody.deletionEligibleThroughSequence, 0);

    assert.equal((await fetch(`${base}/missions/${missionId}/history/export?limit=5001`)).status, 400);
    assert.equal((await fetch(`${base}/missions/missing-history/history/export`)).status, 404);
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const base = await listen(noReaderServer);
    assert.equal((await fetch(`${base}/missions/${missionId}/history/export`)).status, 503);
    assert.equal((await fetch(`${base}/missions/${missionId}/history/retention`)).status, 503);
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
