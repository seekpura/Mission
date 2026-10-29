import assert from "node:assert/strict";
import { appendFile, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FilesystemMissionHistoryArchiveStore } from "../../src/persistence/archive/filesystem-mission-history-archive-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, message: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const event = await events.append({
    id: `archive-store-event-${expected + 1}`,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-store-fixture" },
    payload: { message, nested: { beta: 2, alpha: 1 } },
    schemaVersion: 1,
    createdAt: new Date(1_800_300_000_000 + expected * 1_000).toISOString()
  }, expected);
  return event.sequence;
}

const TAMPER_REJECTION = /content byte mismatch|content SHA-256 mismatch|sequence mismatch|event line is missing missionId|event line has invalid sequence|event line is not canonical JSON|event line is invalid JSON|event count mismatch/;

test("filesystem archive store publishes immutable content-addressed prefixes and verifies them after database restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-history-archive-store-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const store = new FilesystemMissionHistoryArchiveStore(root);
  const missionId = "../../mission-path-must-never-control-archive-storage";

  let latestObjectId = "";
  try {
    await controller.createMission(missionId, "persist a verified Mission archive object");
    await appendSteering(events, missionId, "first");
    await appendSteering(events, missionId, "second");
    const frozenThrough = await events.lastSequence(missionId);

    const first = await store.createFromHistory(history, missionId, { throughSequence: frozenThrough });
    assert.ok(first);
    assert.match(first.objectId, /^[0-9a-f]{64}$/);
    assert.equal(first.objectId, first.receipt.receiptSha256);
    assert.equal(first.receipt.throughSequence, frozenThrough);
    assert.equal(first.receipt.authorizesDeletion, false);

    const objectNames = await readdir(join(root, "objects"));
    assert.deepEqual(objectNames, [first.objectId]);
    assert.equal(objectNames.some(name => name.includes("mission-path")), false);
    const manifest = JSON.parse(await readFile(join(root, "objects", first.objectId, "manifest.json"), "utf8")) as {
      format: string;
      objectId: string;
    };
    assert.equal(manifest.format, "mission-history-archive-object/v1");
    assert.equal(manifest.objectId, first.objectId);

    const samePrefix = await store.createFromHistory(history, missionId, { throughSequence: frozenThrough });
    assert.deepEqual(samePrefix, first);
    assert.deepEqual(await readdir(join(root, "objects")), [first.objectId]);

    await appendSteering(events, missionId, "live tail creates a new immutable archive object");
    const extended = await store.createFromHistory(history, missionId);
    assert.ok(extended);
    assert.notEqual(extended.objectId, first.objectId);
    assert.equal(extended.receipt.throughSequence, frozenThrough + 1);
    latestObjectId = extended.objectId;

    const objectsAfterGrowth = (await readdir(join(root, "objects"))).sort();
    assert.deepEqual(objectsAfterGrowth, [first.objectId, extended.objectId].sort());
    assert.deepEqual(await store.verifyObject(first.objectId), first);
    assert.deepEqual(await store.verifyObject(extended.objectId), extended);
    assert.deepEqual(await readdir(join(root, ".staging")), []);

    await appendFile(join(root, "objects", first.objectId, "events.jsonl"), "{}\n", "utf8");
    await assert.rejects(
      () => store.verifyObject(first.objectId),
      TAMPER_REJECTION
    );
    await assert.rejects(
      () => store.createFromHistory(history, missionId, { throughSequence: frozenThrough }),
      TAMPER_REJECTION
    );
    assert.deepEqual(await store.verifyObject(extended.objectId), extended);

    await assert.rejects(
      () => store.verifyObject("../outside"),
      /lowercase SHA-256 hex digest/
    );
  } finally {
    database.close();
  }

  try {
    assert.match(latestObjectId, /^[0-9a-f]{64}$/);
    const restartedStore = new FilesystemMissionHistoryArchiveStore(root);
    const restarted = await restartedStore.verifyObject(latestObjectId);
    assert.equal(restarted.objectId, latestObjectId);
    assert.equal(restarted.receipt.receiptSha256, latestObjectId);
    assert.equal(restarted.receipt.authorizesDeletion, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
