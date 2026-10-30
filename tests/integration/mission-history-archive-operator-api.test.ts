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
import {
  MissionHistoryArchiveConflictError,
  MissionHistoryArchiveInternalError,
  MissionHistoryArchiveUnavailableError,
  RuntimeMissionHistoryArchiveOperator,
  type MissionHistoryArchiveOperator
} from "../../src/runtime/mission-history-archive-operator.ts";
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

async function appendSteering(events: SqliteEventStore, missionId: string, message: string): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id: `archive-operator-event-${expected + 1}`,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-operator-fixture" },
    payload: { message },
    schemaVersion: 1,
    createdAt: new Date(1_800_500_000_000 + expected * 1000).toISOString()
  }, expected);
}

function objectDirectory(root: string, objectId: string): string {
  return join(root, "objects", objectId.slice(0, 2), objectId);
}

test("operator API creates, durably registers and verifies immutable Mission archives without changing retention", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-operator-api-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteHistoryReader(database);
  const store = new FileMissionHistoryArchiveStore(root);
  const historyArchive = new RuntimeMissionHistoryArchiveOperator(historyReader, store, events);
  const missionId = "mission-archive-operator-api";
  const server = createMissionApi(controller, events, { historyReader, historyArchive });

  try {
    await controller.createMission(missionId, "operator archives are explicit and durably registered");
    await appendSteering(events, missionId, "freeze this prefix");
    const throughSequence = await events.lastSequence(missionId);
    const base = await listen(server);

    const firstResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence })
    });
    assert.equal(firstResponse.status, 200);
    const first = await firstResponse.json() as {
      objectId: string;
      receipt: { missionId: string; throughSequence: number; authorizesDeletion: boolean };
    };
    assert.match(first.objectId, /^[0-9a-f]{64}$/);
    assert.equal(first.receipt.missionId, missionId);
    assert.equal(first.receipt.throughSequence, throughSequence);
    assert.equal(first.receipt.authorizesDeletion, false);

    const repeatedResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence })
    });
    assert.equal(repeatedResponse.status, 200);
    assert.deepEqual(await repeatedResponse.json(), first);
    const registrationEvents = (await events.list(missionId)).filter(event => event.type === "history.archive.created");
    assert.equal(registrationEvents.length, 1);

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

    const invalidHash = await fetch(`${base}/missions/${missionId}/history/archive/not-a-hash`);
    assert.equal(invalidHash.status, 400);
    assert.deepEqual(await invalidHash.json(), { error: "invalid_archive_object_id" });

    const invalidBody = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence: "1" })
    });
    assert.equal(invalidBody.status, 400);
    assert.deepEqual(await invalidBody.json(), { error: "invalid_history_through_sequence" });

    const missingMission = await fetch(`${base}/missions/missing-mission/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}"
    });
    assert.equal(missingMission.status, 404);
    assert.deepEqual(await missingMission.json(), { error: "mission_not_found" });

    await appendFile(join(objectDirectory(root, first.objectId), "events.jsonl"), "tampered\n", "utf8");
    const tamperedVerify = await fetch(`${base}/missions/${missionId}/history/archive/${first.objectId}`);
    assert.equal(tamperedVerify.status, 409);
    assert.deepEqual(await tamperedVerify.json(), { error: "archive_object_conflict" });
    const recreateTampered = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence })
    });
    assert.equal(recreateTampered.status, 409);
    assert.deepEqual(await recreateTampered.json(), { error: "archive_object_conflict" });
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

test("archive API maps typed failures to stable non-leaking status codes", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const missionId = "mission-archive-error-contract";
  await controller.createMission(missionId, "stable archive API error contract");

  const cases: Array<{
    error: Error;
    expectedStatus: number;
    expectedBody: { error: string };
  }> = [
    {
      error: new MissionHistoryArchiveConflictError("/secret/archive/path is corrupt"),
      expectedStatus: 409,
      expectedBody: { error: "archive_object_conflict" }
    },
    {
      error: new MissionHistoryArchiveUnavailableError("EACCES /secret/archive/path"),
      expectedStatus: 503,
      expectedBody: { error: "history_archive_storage_unavailable" }
    },
    {
      error: new MissionHistoryArchiveInternalError("sqlite path /secret/mission.db failed"),
      expectedStatus: 500,
      expectedBody: { error: "history_archive_internal_error" }
    }
  ];

  try {
    for (const [index, fixture] of cases.entries()) {
      const historyArchive: MissionHistoryArchiveOperator = {
        async create() { throw fixture.error; },
        async verify() { throw fixture.error; }
      };
      const server = createMissionApi(controller, events, { historyArchive });
      try {
        const base = await listen(server);
        const createResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}"
        });
        assert.equal(createResponse.status, fixture.expectedStatus, `create fixture ${index}`);
        assert.deepEqual(await createResponse.json(), fixture.expectedBody);

        const verifyResponse = await fetch(`${base}/missions/${missionId}/history/archive/${"b".repeat(64)}`);
        assert.equal(verifyResponse.status, fixture.expectedStatus, `verify fixture ${index}`);
        assert.deepEqual(await verifyResponse.json(), fixture.expectedBody);
      } finally {
        await closeServer(server);
      }
    }
  } finally {
    database.close();
  }
});
