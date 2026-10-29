import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-object-fixture" },
    payload: { message: id, nested: { beta: 2, alpha: 1 } },
    schemaVersion: 1,
    createdAt: new Date(1_800_003_000_000 + expected * 1000).toISOString()
  }, expected);
}

function objectDirectory(root: string, objectId: string): string {
  return join(root, "objects", objectId.slice(0, 2), objectId);
}

test("content-addressed Mission archive objects are immutable, restart-verifiable and tamper-evident", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-history-archive-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const store = new FileMissionHistoryArchiveStore(root);
  const missionId = "mission-archive-object";
  let databaseClosed = false;

  try {
    await controller.createMission(missionId, "persist a verified Mission history archive");
    await appendSteering(events, missionId, "archive-object-4");
    await appendSteering(events, missionId, "archive-object-5");

    const first = await store.archive(history, missionId);
    assert.ok(first);
    assert.equal(first.objectId, first.receipt.receiptSha256);
    assert.equal(first.receipt.throughSequence, 5);
    assert.equal(first.receipt.authorizesDeletion, false);

    const repeated = await store.archive(history, missionId, { throughSequence: 5 });
    assert.deepEqual(repeated, first);
    assert.deepEqual(await store.verify(first.objectId), first);

    const prefixEntries = await readdir(join(root, "objects", first.objectId.slice(0, 2)));
    assert.deepEqual(prefixEntries, [first.objectId]);

    await appendSteering(events, missionId, "archive-object-6-live-tail");
    const second = await store.archive(history, missionId);
    assert.ok(second);
    assert.equal(second.receipt.throughSequence, 6);
    assert.notEqual(second.objectId, first.objectId);
    assert.deepEqual(await store.verify(second.objectId), second);

    const firstEventsPath = join(objectDirectory(root, first.objectId), "events.jsonl");
    await appendFile(firstEventsPath, "tampered\n", "utf8");
    await assert.rejects(() => store.verify(first.objectId), /exceeds receipt contentBytes|SHA-256 mismatch|invalid/i);
    await assert.rejects(
      () => store.archive(history, missionId, { throughSequence: 5 }),
      /exceeds receipt contentBytes|SHA-256 mismatch|invalid/i
    );

    assert.equal(await store.archive(history, "missing-mission"), undefined);
    await assert.rejects(() => store.verify("../not-an-object"), /lowercase SHA-256 hex/);

    database.close();
    databaseClosed = true;

    const restartedStore = new FileMissionHistoryArchiveStore(root);
    assert.deepEqual(await restartedStore.verify(second.objectId), second);

    const secondReceiptPath = join(objectDirectory(root, second.objectId), "receipt.json");
    const receipt = JSON.parse(await readFile(secondReceiptPath, "utf8")) as Record<string, unknown>;
    receipt.missionId = "tampered-mission";
    await writeFile(secondReceiptPath, `${JSON.stringify(receipt)}\n`, "utf8");
    await assert.rejects(
      () => restartedStore.verify(second.objectId),
      /not canonical|SHA-256 mismatch|does not match/i
    );
  } finally {
    if (!databaseClosed) database.close();
    await rm(root, { recursive: true, force: true });
  }
});
