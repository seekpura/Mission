import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionHistoryReader } from "../../src/persistence/sqlite/sqlite-mission-history-reader.ts";
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

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const event = await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "history-api-fixture" },
    payload: { message: id },
    schemaVersion: 1,
    createdAt: new Date(1_800_000_100_000 + expected * 1000).toISOString()
  }, expected);
  return event.sequence;
}

test("Mission history API exports a fixed prefix and reports deletion-ineligible retention state", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteMissionHistoryReader(database);
  const missionId = "mission-history-api";
  const server = createMissionApi(controller, events, { historyReader });

  try {
    await controller.createMission(missionId, "export Mission history safely");
    await appendSteering(events, missionId, "history-api-4");
    await appendSteering(events, missionId, "history-api-5");
    const base = await listen(server);

    const firstResponse = await fetch(`${base}/missions/${missionId}/history/export?limit=2`);
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      format: string;
      throughSequence: number;
      latestSequenceAtRead: number;
      events: Array<{ sequence: number }>;
      complete: boolean;
      nextAfterSequence?: number;
    };
    assert.equal(first.format, "mission-events/v1");
    assert.equal(first.throughSequence, 5);
    assert.equal(first.latestSequenceAtRead, 5);
    assert.deepEqual(first.events.map(event => event.sequence), [1, 2]);
    assert.equal(first.complete, false);
    assert.equal(first.nextAfterSequence, 2);

    await appendSteering(events, missionId, "history-api-6-live-tail");

    const secondResponse = await fetch(
      `${base}/missions/${missionId}/history/export?afterSequence=${first.nextAfterSequence}&throughSequence=${first.throughSequence}&limit=3`
    );
    assert.equal(secondResponse.status, 200);
    const second = await secondResponse.json() as {
      throughSequence: number;
      latestSequenceAtRead: number;
      events: Array<{ sequence: number }>;
      complete: boolean;
    };
    assert.equal(second.throughSequence, 5);
    assert.equal(second.latestSequenceAtRead, 6);
    assert.deepEqual(second.events.map(event => event.sequence), [3, 4, 5]);
    assert.equal(second.complete, true);

    const retentionResponse = await fetch(`${base}/missions/${missionId}/history/retention`);
    assert.equal(retentionResponse.status, 200);
    const retention = await retentionResponse.json() as {
      policy: string;
      latestSequence: number;
      fullHistoryPresent: boolean;
      deletionEligibleThroughSequence: number;
      reason: string;
    };
    assert.equal(retention.policy, "full-history-required");
    assert.equal(retention.latestSequence, 6);
    assert.equal(retention.fullHistoryPresent, true);
    assert.equal(retention.deletionEligibleThroughSequence, 0);
    assert.match(retention.reason, /do not authorize deletion/);

    assert.equal((await fetch(`${base}/missions/${missionId}/history/export?limit=5001`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/history/export?afterSequence=-1`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/history/export?throughSequence=-1`)).status, 400);

    const missingExport = await fetch(`${base}/missions/missing-mission/history/export`);
    assert.equal(missingExport.status, 404);
    assert.deepEqual(await missingExport.json(), { error: "mission_not_found" });
    const missingRetention = await fetch(`${base}/missions/missing-mission/history/retention`);
    assert.equal(missingRetention.status, 404);
    assert.deepEqual(await missingRetention.json(), { error: "mission_not_found" });
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const base = await listen(noReaderServer);
    const exportResponse = await fetch(`${base}/missions/${missionId}/history/export`);
    assert.equal(exportResponse.status, 503);
    assert.deepEqual(await exportResponse.json(), { error: "history_reader_unavailable" });
    const retentionResponse = await fetch(`${base}/missions/${missionId}/history/retention`);
    assert.equal(retentionResponse.status, 503);
    assert.deepEqual(await retentionResponse.json(), { error: "history_reader_unavailable" });
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
