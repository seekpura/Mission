import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader, type MissionArchiveReceipt } from "../../src/persistence/sqlite/sqlite-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, message: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const committed = await events.append({
    id: `receipt-event-${expected + 1}`,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "receipt-fixture" },
    payload: { message, nested: { z: 1, a: [3, 2, 1] } },
    schemaVersion: 1,
    createdAt: new Date(1_800_200_000_000 + expected * 1_000).toISOString()
  }, expected);
  return committed.sequence;
}

function independentCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new Error("non-finite number in test canonicalization");
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) return `[${value.map(independentCanonicalJson).join(",")}]`;
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${independentCanonicalJson(item)}`)
        .join(",")}}`;
    default:
      throw new Error(`unsupported test canonical value: ${typeof value}`);
  }
}

function independentReceipt(missionId: string, throughSequence: number, events: MissionEvent[]): MissionArchiveReceipt {
  const content = createHash("sha256");
  for (const event of events) content.update(`${independentCanonicalJson(event)}\n`, "utf8");
  const core = {
    format: "mission-archive-receipt/v1" as const,
    eventFormat: "mission-events/v1" as const,
    eventCanonicalization: "canonical-json-lines/v1" as const,
    receiptCanonicalization: "canonical-json/v1" as const,
    hashAlgorithm: "sha256" as const,
    missionId,
    throughSequence,
    eventCount: events.length,
    contentSha256: content.digest("hex")
  };
  return {
    ...core,
    receiptSha256: createHash("sha256").update(independentCanonicalJson(core), "utf8").digest("hex")
  };
}

function collectPrefix(reader: SqliteHistoryReader, missionId: string, throughSequence: number): MissionEvent[] {
  const collected: MissionEvent[] = [];
  let afterSequence = 0;
  while (afterSequence < throughSequence) {
    const page = reader.readExportPage(missionId, { afterSequence, throughSequence, limit: 2 });
    assert.ok(page);
    collected.push(...page.events);
    if (page.complete) break;
    assert.equal(typeof page.nextAfterSequence, "number");
    afterSequence = page.nextAfterSequence as number;
  }
  return collected;
}

test("archive receipt is externally reproducible and stable for a frozen Mission prefix", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const eventStore = new SqliteEventStore(database);
  const controller = new MissionController(eventStore);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-archive-receipt";

  try {
    await controller.createMission(missionId, "produce a reproducible archive receipt");
    await appendSteering(eventStore, missionId, "first");
    await appendSteering(eventStore, missionId, "second");
    const throughSequence = await eventStore.lastSequence(missionId);

    const receipt = reader.createArchiveReceipt(missionId, throughSequence);
    assert.ok(receipt);
    assert.equal(receipt.format, "mission-archive-receipt/v1");
    assert.equal(receipt.eventCanonicalization, "canonical-json-lines/v1");
    assert.equal(receipt.receiptCanonicalization, "canonical-json/v1");
    assert.equal(receipt.hashAlgorithm, "sha256");
    assert.equal(receipt.throughSequence, throughSequence);
    assert.equal(receipt.eventCount, throughSequence);

    const exported = collectPrefix(reader, missionId, throughSequence);
    assert.deepEqual(receipt, independentReceipt(missionId, throughSequence, exported));

    await appendSteering(eventStore, missionId, "live tail after frozen receipt");
    const samePrefix = reader.createArchiveReceipt(missionId, throughSequence);
    assert.deepEqual(samePrefix, receipt);

    const latestReceipt = reader.createArchiveReceipt(missionId);
    assert.ok(latestReceipt);
    assert.equal(latestReceipt.throughSequence, throughSequence + 1);
    assert.equal(latestReceipt.eventCount, throughSequence + 1);
    assert.notEqual(latestReceipt.contentSha256, receipt.contentSha256);
    assert.notEqual(latestReceipt.receiptSha256, receipt.receiptSha256);

    assert.equal(reader.createArchiveReceipt("missing-mission"), undefined);
  } finally {
    database.close();
  }
});

test("archive receipt refuses to certify a Mission prefix with an event-sequence gap", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const eventStore = new SqliteEventStore(database);
  const controller = new MissionController(eventStore);
  const reader = new SqliteHistoryReader(database);
  const missionId = "mission-archive-receipt-gap";

  try {
    await controller.createMission(missionId, "detect archive corruption");
    await appendSteering(eventStore, missionId, "extra");
    const throughSequence = await eventStore.lastSequence(missionId);
    database.db.prepare(
      "DELETE FROM mission_events WHERE mission_id = ? AND sequence = 2"
    ).run(missionId);

    assert.throws(
      () => reader.createArchiveReceipt(missionId, throughSequence),
      /sequence gap/
    );
  } finally {
    database.close();
  }
});
