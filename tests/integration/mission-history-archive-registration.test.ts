import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { MissionHistoryArchiveReceiptReader } from "../../src/persistence/sqlite/mission-history-archive-receipt.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";
import { RuntimeMissionHistoryArchiveOperator } from "../../src/runtime/mission-history-archive-operator.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, message: string): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id: `archive-registration-steer-${expected + 1}`,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-registration-fixture" },
    payload: { message },
    schemaVersion: 1,
    createdAt: new Date(1_800_400_000_000 + expected * 1000).toISOString()
  }, expected);
}

class FailOnceArchiveAuditEventStore implements EventStore {
  private failed = false;
  private readonly inner: EventStore;
  private readonly mode: "storage" | "concurrency";

  constructor(inner: EventStore, mode: "storage" | "concurrency") {
    this.inner = inner;
    this.mode = mode;
  }

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    if (!this.failed && event.type === "history.archive.created") {
      this.failed = true;
      if (this.mode === "concurrency") {
        const error = new Error("expected sequence changed during archive registration");
        error.name = "ConcurrencyConflictError";
        throw error;
      }
      throw new Error("simulated archive audit persistence failure");
    }
    return this.inner.append(event, expectedSequence);
  }

  list(missionId: string, afterSequence?: number): Promise<MissionEvent[]> {
    return this.inner.list(missionId, afterSequence);
  }

  lastSequence(missionId: string): Promise<number> {
    return this.inner.lastSequence(missionId);
  }
}

test("archive create durably registers one idempotent history.archive.created event per object across operator restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-registration-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const store = new FileMissionHistoryArchiveStore(root);
  const operator = new RuntimeMissionHistoryArchiveOperator(history, store, events);
  const missionId = "mission-archive-registration";

  try {
    await controller.createMission(missionId, "register verified archive objects durably");
    await appendSteering(events, missionId, "freeze this prefix");
    const throughSequence = await events.lastSequence(missionId);

    const first = await operator.create(missionId, { throughSequence });
    assert.ok(first);
    assert.equal(first.receipt.throughSequence, throughSequence);
    assert.equal(first.receipt.authorizesDeletion, false);

    const restartedOperator = new RuntimeMissionHistoryArchiveOperator(history, store, events);
    const repeated = await restartedOperator.create(missionId, { throughSequence });
    assert.deepEqual(repeated, first);

    const audit = (await events.list(missionId)).filter(event => event.type === "history.archive.created");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.sequence, throughSequence + 1);
    assert.equal(audit[0]?.idempotencyKey, `history-archive-created:${first.objectId}`);
    assert.deepEqual(audit[0]?.actor, { type: "system", id: "mission-history-archive-operator" });
    assert.deepEqual(audit[0]?.payload, {
      objectId: first.objectId,
      storage: "filesystem",
      receipt: first.receipt
    });
    assert.equal(await events.lastSequence(missionId), throughSequence + 1);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive object may survive audit persistence failure but is not registered until retry succeeds", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-registration-failure-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const durableEvents = new SqliteEventStore(database);
  const controller = new MissionController(durableEvents);
  const history = new SqliteHistoryReader(database);
  const store = new FileMissionHistoryArchiveStore(root);
  const events = new FailOnceArchiveAuditEventStore(durableEvents, "storage");
  const operator = new RuntimeMissionHistoryArchiveOperator(history, store, events);
  const missionId = "mission-archive-registration-failure";

  try {
    await controller.createMission(missionId, "recover archive registration after audit persistence failure");
    const throughSequence = await durableEvents.lastSequence(missionId);
    const receipt = new MissionHistoryArchiveReceiptReader(history).readReceipt(missionId, { throughSequence });
    assert.ok(receipt);

    await assert.rejects(
      () => operator.create(missionId, { throughSequence }),
      /simulated archive audit persistence failure/
    );

    const residualObject = await store.verify(receipt.receiptSha256);
    assert.equal(residualObject.objectId, receipt.receiptSha256);
    assert.equal(
      (await durableEvents.list(missionId)).filter(event => event.type === "history.archive.created").length,
      0
    );

    const recovered = await operator.create(missionId, { throughSequence });
    assert.ok(recovered);
    assert.equal(recovered.objectId, receipt.receiptSha256);
    const audit = (await durableEvents.list(missionId)).filter(event => event.type === "history.archive.created");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.idempotencyKey, `history-archive-created:${receipt.receiptSha256}`);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive registration retries optimistic concurrency conflicts without duplicating the audit event", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-registration-conflict-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const durableEvents = new SqliteEventStore(database);
  const controller = new MissionController(durableEvents);
  const history = new SqliteHistoryReader(database);
  const store = new FileMissionHistoryArchiveStore(root);
  const events = new FailOnceArchiveAuditEventStore(durableEvents, "concurrency");
  const operator = new RuntimeMissionHistoryArchiveOperator(history, store, events);
  const missionId = "mission-archive-registration-conflict";

  try {
    await controller.createMission(missionId, "retry archive registration concurrency");
    const throughSequence = await durableEvents.lastSequence(missionId);
    const archived = await operator.create(missionId, { throughSequence });
    assert.ok(archived);

    const audit = (await durableEvents.list(missionId)).filter(event => event.type === "history.archive.created");
    assert.equal(audit.length, 1);
    assert.equal(audit[0]?.idempotencyKey, `history-archive-created:${archived.objectId}`);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
