import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { SqliteReadModelProjector } from "../../src/persistence/sqlite/sqlite-read-model-projector.ts";
import { RuntimeMissionHistoryArchiveOperator } from "../../src/runtime/mission-history-archive-operator.ts";
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

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-registry-fixture" },
    payload: { message: id },
    schemaVersion: 1,
    createdAt: new Date(1_800_500_000_000 + expected * 1000).toISOString()
  }, expected);
}

test("durable archive registry is bounded, event-sequence paged and rebuildable from history.archive.created", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-registry-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const reader = new SqliteMissionReader(database);
  const operator = new RuntimeMissionHistoryArchiveOperator(
    history,
    new FileMissionHistoryArchiveStore(root),
    events
  );
  const missionId = "mission-archive-registry";

  try {
    await controller.createMission(missionId, "enumerate durable registered archives without scanning events");
    const firstThrough = await events.lastSequence(missionId);
    const first = await operator.create(missionId, { throughSequence: firstThrough });
    assert.ok(first);
    const firstRegistrationSequence = await events.lastSequence(missionId);

    const repeated = await operator.create(missionId, { throughSequence: firstThrough });
    assert.deepEqual(repeated, first);
    assert.equal(await events.lastSequence(missionId), firstRegistrationSequence);

    await appendSteering(events, missionId, "archive-registry-live-tail");
    const secondThrough = await events.lastSequence(missionId);
    const second = await operator.create(missionId, { throughSequence: secondThrough });
    assert.ok(second);
    const secondRegistrationSequence = await events.lastSequence(missionId);

    const firstPage = reader.readHistoryArchives(missionId, { limit: 1 });
    assert.ok(firstPage);
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.items[0]?.objectId, first.objectId);
    assert.equal(firstPage.items[0]?.eventSequence, firstRegistrationSequence);
    assert.equal(firstPage.items[0]?.receipt.authorizesDeletion, false);
    assert.equal(firstPage.nextAfterSequence, firstRegistrationSequence);

    const secondPage = reader.readHistoryArchives(missionId, {
      afterSequence: firstPage.nextAfterSequence,
      limit: 1
    });
    assert.ok(secondPage);
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0]?.objectId, second.objectId);
    assert.equal(secondPage.items[0]?.eventSequence, secondRegistrationSequence);
    assert.equal(secondPage.nextAfterSequence, undefined);

    assert.throws(() => reader.readHistoryArchives(missionId, { afterSequence: -1 }), /afterSequence/);
    assert.throws(() => reader.readHistoryArchives(missionId, { limit: 501 }), /limit/);
    assert.equal(reader.readHistoryArchives("missing-mission"), undefined);

    database.db.exec(`
      DELETE FROM rm_history_archives;
      DELETE FROM rm_projection_checkpoints WHERE projection_name = 'mission-read-model-v1';
    `);
    new SqliteReadModelProjector(database).catchUpAll();
    const rebuilt = reader.readHistoryArchives(missionId, { limit: 10 });
    assert.ok(rebuilt);
    assert.deepEqual(
      rebuilt.items.map(item => ({ objectId: item.objectId, eventSequence: item.eventSequence })),
      [
        { objectId: first.objectId, eventSequence: firstRegistrationSequence },
        { objectId: second.objectId, eventSequence: secondRegistrationSequence }
      ]
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Mission API exposes bounded registered archive history and fails closed without its registry reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-registry-api-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteHistoryReader(database);
  const missionReader = new SqliteMissionReader(database);
  const historyArchive = new RuntimeMissionHistoryArchiveOperator(
    historyReader,
    new FileMissionHistoryArchiveStore(root),
    events
  );
  const missionId = "mission-archive-registry-api";
  const server = createMissionApi(controller, events, {
    historyReader,
    historyArchive,
    historyArchiveReader: missionReader
  });

  try {
    await controller.createMission(missionId, "query registered archive history over HTTP");
    const first = await historyArchive.create(missionId, { throughSequence: await events.lastSequence(missionId) });
    assert.ok(first);
    const firstRegistrationSequence = await events.lastSequence(missionId);
    await appendSteering(events, missionId, "archive-registry-api-tail");
    const second = await historyArchive.create(missionId, { throughSequence: await events.lastSequence(missionId) });
    assert.ok(second);

    const base = await listen(server);
    const firstPageResponse = await fetch(`${base}/missions/${missionId}/history/archives?limit=1`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json() as {
      items: Array<{ objectId: string; eventSequence: number }>;
      nextAfterSequence?: number;
    };
    assert.deepEqual(firstPage.items, [{ objectId: first.objectId, eventSequence: firstRegistrationSequence }], {
      partial: true
    } as never);
    assert.equal(firstPage.nextAfterSequence, firstRegistrationSequence);

    const secondPageResponse = await fetch(
      `${base}/missions/${missionId}/history/archives?afterSequence=${firstRegistrationSequence}&limit=1`
    );
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json() as {
      items: Array<{ objectId: string; eventSequence: number }>;
      nextAfterSequence?: number;
    };
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.items[0]?.objectId, second.objectId);
    assert.equal(secondPage.nextAfterSequence, undefined);

    assert.equal((await fetch(`${base}/missions/${missionId}/history/archives?afterSequence=-1`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/history/archives?limit=501`)).status, 400);
    assert.equal((await fetch(`${base}/missions/missing-mission/history/archives`)).status, 404);
  } finally {
    await closeServer(server);
  }

  const disabledServer = createMissionApi(controller, events, { historyReader });
  try {
    const base = await listen(disabledServer);
    const response = await fetch(`${base}/missions/${missionId}/history/archives`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "history_archive_registry_unavailable" });
  } finally {
    await closeServer(disabledServer);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
