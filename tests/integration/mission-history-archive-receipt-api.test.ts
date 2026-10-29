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

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-receipt-api-fixture" },
    payload: { message: id },
    schemaVersion: 1,
    createdAt: new Date(1_800_002_000_000 + expected * 1000).toISOString()
  }, expected);
}

test("Mission archive receipt API exposes a fixed integrity receipt and fails closed without history authority", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteHistoryReader(database);
  const missionId = "mission-archive-receipt-api";
  const server = createMissionApi(controller, events, { historyReader });

  try {
    await controller.createMission(missionId, "expose archive integrity receipt");
    await appendSteering(events, missionId, "archive-receipt-api-4");
    await appendSteering(events, missionId, "archive-receipt-api-5");
    const base = await listen(server);

    const currentResponse = await fetch(`${base}/missions/${missionId}/history/archive-receipt`);
    assert.equal(currentResponse.status, 200);
    const current = await currentResponse.json() as {
      format: string;
      throughSequence: number;
      eventCount: number;
      contentSha256: string;
      receiptSha256: string;
      authorizesDeletion: boolean;
    };
    assert.equal(current.format, "mission-history-archive-receipt/v1");
    assert.equal(current.throughSequence, 5);
    assert.equal(current.eventCount, 5);
    assert.match(current.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(current.receiptSha256, /^[0-9a-f]{64}$/);
    assert.equal(current.authorizesDeletion, false);

    await appendSteering(events, missionId, "archive-receipt-api-6-live-tail");
    const fixedResponse = await fetch(`${base}/missions/${missionId}/history/archive-receipt?throughSequence=5`);
    assert.equal(fixedResponse.status, 200);
    assert.deepEqual(await fixedResponse.json(), current);

    const invalid = await fetch(`${base}/missions/${missionId}/history/archive-receipt?throughSequence=-1`);
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: "invalid_history_through_sequence" });

    const missing = await fetch(`${base}/missions/missing-mission/history/archive-receipt`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "mission_not_found" });
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const base = await listen(noReaderServer);
    const response = await fetch(`${base}/missions/${missionId}/history/archive-receipt`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "history_reader_unavailable" });
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
