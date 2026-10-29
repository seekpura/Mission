import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionHistoryArchiveReceiptReader } from "../../src/persistence/sqlite/mission-history-archive-receipt.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function appendSteering(events: SqliteEventStore, missionId: string, id: string): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const event = await events.append({
    id,
    missionId,
    type: "user.steering.received",
    actor: { type: "user", id: "archive-receipt-fixture" },
    payload: { z: id, nested: { beta: 2, alpha: 1 }, a: "stable-order" },
    schemaVersion: 1,
    createdAt: new Date(1_800_001_000_000 + expected * 1000).toISOString()
  }, expected);
  return event.sequence;
}

test("Mission archive receipt is deterministic, externally reproducible and fail-closed on history damage", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const receipts = new MissionHistoryArchiveReceiptReader(history);
  const missionId = "mission-archive-receipt";

  try {
    await controller.createMission(missionId, "produce a verifiable archive receipt");
    await appendSteering(events, missionId, "archive-receipt-4");
    await appendSteering(events, missionId, "archive-receipt-5");
    assert.equal(await events.lastSequence(missionId), 5);

    const receipt = receipts.readReceipt(missionId);
    assert.ok(receipt);
    assert.equal(receipt.format, "mission-history-archive-receipt/v1");
    assert.equal(receipt.eventFormat, "mission-events/v1");
    assert.equal(receipt.canonicalization, "canonical-json-v1+lf");
    assert.equal(receipt.hashAlgorithm, "sha256");
    assert.equal(receipt.fromSequence, 1);
    assert.equal(receipt.throughSequence, 5);
    assert.equal(receipt.eventCount, 5);
    assert.equal(receipt.authorizesDeletion, false);
    assert.match(receipt.contentSha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.receiptSha256, /^[0-9a-f]{64}$/);

    const exported = history.readExportPage(missionId, { throughSequence: 5, limit: 5000 });
    assert.ok(exported);
    assert.equal(exported.complete, true);
    const externalContent = exported.events.map(externalCanonicalMissionEventLine).join("");
    assert.equal(Buffer.byteLength(externalContent, "utf8"), receipt.contentBytes);
    assert.equal(sha256(externalContent), receipt.contentSha256);

    const { receiptSha256, ...receiptCore } = receipt;
    assert.equal(sha256(externalCanonicalJson(receiptCore)), receiptSha256);

    await appendSteering(events, missionId, "archive-receipt-6-live-tail");
    const samePrefix = receipts.readReceipt(missionId, { throughSequence: 5 });
    assert.deepEqual(samePrefix, receipt);

    const extended = receipts.readReceipt(missionId);
    assert.ok(extended);
    assert.equal(extended.throughSequence, 6);
    assert.equal(extended.eventCount, 6);
    assert.notEqual(extended.contentSha256, receipt.contentSha256);
    assert.notEqual(extended.receiptSha256, receipt.receiptSha256);
    assert.equal(extended.authorizesDeletion, false);

    const futureBound = receipts.readReceipt(missionId, { throughSequence: 999 });
    assert.deepEqual(futureBound, extended);

    database.db.prepare("DELETE FROM mission_events WHERE mission_id = ? AND sequence = 4").run(missionId);
    assert.throws(
      () => receipts.readReceipt(missionId, { throughSequence: 6 }),
      /sequence gap/
    );

    assert.equal(receipts.readReceipt("missing-mission"), undefined);
    assert.throws(
      () => receipts.readReceipt(missionId, { throughSequence: -1 }),
      /non-negative safe integer/
    );
  } finally {
    database.close();
  }
});

function externalCanonicalMissionEventLine(event: MissionEvent): string {
  return `${externalCanonicalJson(event)}\n`;
}

function externalCanonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("external canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined) throw new Error("external canonical JSON rejects undefined array entries");
      return externalCanonicalJson(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .filter(key => object[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${externalCanonicalJson(object[key])}`)
      .join(",")}}`;
  }
  throw new Error(`external canonical JSON rejects unsupported type ${typeof value}`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
