import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";
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
    actor: { type: "user", id: "archive-operator-fixture" },
    payload: { message: id },
    schemaVersion: 1,
    createdAt: new Date(1_800_004_000_000 + expected * 1000).toISOString()
  }, expected);
}

function objectDirectory(root: string, objectId: string): string {
  return join(root, "objects", objectId.slice(0, 2), objectId);
}

test("operator API explicitly creates and verifies immutable Mission archives without changing retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-operator-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteHistoryReader(database);
  const historyArchive = new RuntimeMissionHistoryArchiveOperator(
    historyReader,
    new FileMissionHistoryArchiveStore(root)
  );
  const missionId = "mission-archive-operator";
  const server = createMissionApi(controller, events, { historyReader, historyArchive });

  try {
    await controller.createMission(missionId, "create archives only when an operator asks");
    await appendSteering(events, missionId, "archive-operator-4");
    await appendSteering(events, missionId, "archive-operator-5");
    const base = await listen(server);

    const firstResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: 5 })
    });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      objectId: string;
      receipt: { missionId: string; throughSequence: number; authorizesDeletion: boolean };
    };
    assert.match(first.objectId, /^[0-9a-f]{64}$/);
    assert.equal(first.receipt.missionId, missionId);
    assert.equal(first.receipt.throughSequence, 5);
    assert.equal(first.receipt.authorizesDeletion, false);

    const repeated = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: 5 })
    });
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), first);

    await appendSteering(events, missionId, "archive-operator-6-live-tail");
    const latestResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(latestResponse.status, 200);
    const latest = await latestResponse.json() as { objectId: string; receipt: { throughSequence: number } };
    assert.equal(latest.receipt.throughSequence, 6);
    assert.notEqual(latest.objectId, first.objectId);

    const verify = await fetch(`${base}/missions/${missionId}/history/archive/${first.objectId}`);
    assert.equal(verify.status, 200);
    assert.deepEqual(await verify.json(), first);

    const crossMission = await fetch(`${base}/missions/another-mission/history/archive/${first.objectId}`);
    assert.equal(crossMission.status, 404);
    assert.deepEqual(await crossMission.json(), { error: "archive_object_not_found" });

    const retention = await fetch(`${base}/missions/${missionId}/history/retention`);
    assert.equal(retention.status, 200);
    const retentionBody = await retention.json() as { deletionEligibleThroughSequence: number };
    assert.equal(retentionBody.deletionEligibleThroughSequence, 0);

    assert.equal((await fetch(`${base}/missions/${missionId}/history/archive/not-a-hash`)).status, 400);
    const invalidBody = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: "5" })
    });
    assert.equal(invalidBody.status, 400);
    const negativeBody = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: -1 })
    });
    assert.equal(negativeBody.status, 400);

    const missingMission = await fetch(`${base}/missions/missing-mission/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(missingMission.status, 404);

    await appendFile(join(objectDirectory(root, first.objectId), "events.jsonl"), "tampered\n", "utf8");
    const tampered = await fetch(`${base}/missions/${missionId}/history/archive/${first.objectId}`);
    assert.equal(tampered.status, 409);
    assert.deepEqual(await tampered.json(), { error: "archive_verification_failed" });
    const recreateTampered = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: 5 })
    });
    assert.equal(recreateTampered.status, 409);
    assert.deepEqual(await recreateTampered.json(), { error: "history_archive_creation_failed" });
  } finally {
    await closeServer(server);
  }

  const disabledServer = createMissionApi(controller, events, { historyReader });
  try {
    const base = await listen(disabledServer);
    const createResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(createResponse.status, 503);
    assert.deepEqual(await createResponse.json(), { error: "history_archive_unavailable" });
    const verifyResponse = await fetch(`${base}/missions/${missionId}/history/archive/${"a".repeat(64)}`);
    assert.equal(verifyResponse.status, 503);
    assert.deepEqual(await verifyResponse.json(), { error: "history_archive_unavailable" });
  } finally {
    await closeServer(disabledServer);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
