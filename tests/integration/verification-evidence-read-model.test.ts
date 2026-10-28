import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Evidence } from "../../src/core/domain/verification.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function evidence(missionId: string): Evidence {
  return {
    id: "evidence-1",
    missionId,
    subjectRef: "artifact-1@1",
    type: "runtime-check",
    kind: "browser-runtime",
    claim: "Browser runtime loaded the target route without a blocking error.",
    result: "supports",
    collectorId: "browser-fixture-v1",
    sourceRef: "browser:fixture",
    details: { viewport: "1440x900", blockingErrors: 0 },
    createdAt: "2026-10-29T01:00:00.000Z"
  };
}

async function appendEvidence(events: SqliteEventStore, value: unknown): Promise<void> {
  const missionId = (value as { missionId?: string }).missionId ?? "mission-evidence";
  const expected = await events.lastSequence(missionId);
  await events.append({
    id: `event-${expected + 1}`,
    missionId,
    type: "evidence.collected",
    actor: { type: "verifier", id: "test" },
    payload: value,
    schemaVersion: 1,
    createdAt: "2026-10-29T01:00:00.000Z"
  }, expected);
}

test("evidence.collected is projected transactionally and queryable by artifact subject", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const missionId = "mission-evidence-read";

  try {
    const value = evidence(missionId);
    await appendEvidence(events, value);

    assert.deepEqual(reader.readEvidence(missionId), [value]);
    assert.deepEqual(reader.readEvidence(missionId, "artifact-1@1"), [value]);
    assert.deepEqual(reader.readEvidence(missionId, "other@1"), []);
  } finally {
    database.close();
  }
});

test("malformed Evidence projection rolls back the Mission Event atomically", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const missionId = "mission-evidence-invalid";

  try {
    const malformed = { ...evidence(missionId), collectorId: "" };
    await assert.rejects(() => appendEvidence(events, malformed), /evidence\.collectorId/);
    assert.equal(await events.lastSequence(missionId), 0);
    assert.deepEqual(reader.readEvidence(missionId), []);
  } finally {
    database.close();
  }
});

test("Evidence read model rebuilds from append-only events after projection loss", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const first = new SqliteEventStore(database);
  const missionId = "mission-evidence-rebuild";
  const value = evidence(missionId);

  try {
    await appendEvidence(first, value);
    database.db.prepare("DELETE FROM rm_evidence WHERE mission_id = ?").run(missionId);
    database.db.prepare(
      "DELETE FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).run("verification-evidence-read-model-v1", missionId);

    new SqliteEventStore(database);
    const reader = new SqliteMissionReader(database);
    assert.deepEqual(reader.readEvidence(missionId), [value]);
  } finally {
    database.close();
  }
});
