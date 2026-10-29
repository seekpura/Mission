import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionSummaryReader } from "../../src/persistence/sqlite/sqlite-mission-summary-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function append(
  events: SqliteEventStore,
  missionId: string,
  type: "mission.created" | "user.steering.received",
  payload: unknown,
  createdAt: string
): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id: `summary-event-${expected + 1}`,
    missionId,
    type,
    actor: { type: "system", id: "summary-fixture" },
    payload,
    schemaVersion: 1,
    createdAt
  }, expected);
}

function insertLifecycle(
  database: MissionDatabase,
  table: "rm_attempts" | "rm_executions",
  missionId: string,
  id: string,
  status: string,
  data: Record<string, unknown>
): void {
  if (table === "rm_attempts") {
    database.db.prepare(`
      INSERT INTO rm_attempts (mission_id, id, work_item_id, status, data_json, updated_at)
      VALUES (?, ?, 'work-1', ?, ?, '2026-10-29T11:59:00.000Z')
    `).run(missionId, id, status, JSON.stringify(data));
    return;
  }
  database.db.prepare(`
    INSERT INTO rm_executions (mission_id, id, work_item_id, attempt_id, status, data_json, updated_at)
    VALUES (?, ?, 'work-1', 'attempt-1', ?, ?, '2026-10-29T11:59:00.000Z')
  `).run(missionId, id, status, JSON.stringify(data));
}

test("Mission operational summary returns aggregate health without materializing raw history", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionSummaryReader(database);
  const missionId = "mission-summary";
  const now = new Date("2026-10-29T12:00:00.000Z");

  try {
    await append(events, missionId, "mission.created", { missionId, userGoal: "observe Mission health" }, "2026-10-29T10:00:00.000Z");
    await append(events, missionId, "user.steering.received", { message: "old note" }, "2026-10-29T10:30:00.000Z");
    await append(events, missionId, "user.steering.received", { message: "recent note" }, "2026-10-29T11:58:00.000Z");

    database.db.prepare(`
      INSERT INTO rm_work_items (mission_id, id, status, data_json, updated_at)
      VALUES (?, 'work-ready', 'ready', '{}', '2026-10-29T11:50:00.000Z'),
             (?, 'work-blocked', 'blocked', '{}', '2026-10-29T11:51:00.000Z')
    `).run(missionId, missionId);
    insertLifecycle(database, "rm_attempts", missionId, "attempt-1", "succeeded", { id: "attempt-1" });
    insertLifecycle(database, "rm_attempts", missionId, "attempt-2", "running", { id: "attempt-2" });
    insertLifecycle(database, "rm_executions", missionId, "execution-1", "completed", {
      id: "execution-1",
      startedAt: "2026-10-29T11:00:00.000Z",
      endedAt: "2026-10-29T11:00:03.000Z"
    });
    insertLifecycle(database, "rm_executions", missionId, "execution-2", "completed", {
      id: "execution-2",
      startedAt: "2026-10-29T11:10:00.000Z",
      endedAt: "2026-10-29T11:10:09.000Z"
    });
    insertLifecycle(database, "rm_executions", missionId, "execution-running", "running", {
      id: "execution-running",
      startedAt: "2026-10-29T11:30:00.000Z"
    });

    database.db.prepare(`
      INSERT INTO rm_artifacts (mission_id, id, version, logical_name, status, data_json, updated_at)
      VALUES (?, 'artifact-1', 1, 'deliverable', 'candidate', '{}', '2026-10-29T11:40:00.000Z')
    `).run(missionId);
    database.db.prepare(`
      INSERT INTO rm_gaps (mission_id, id, status, severity, data_json, updated_at)
      VALUES (?, 'gap-1', 'open', 'major', '{}', '2026-10-29T11:41:00.000Z')
    `).run(missionId);
    database.db.prepare(`
      INSERT INTO rm_approvals (mission_id, id, status, data_json, updated_at)
      VALUES (?, 'approval-1', 'pending', '{}', '2026-10-29T11:42:00.000Z')
    `).run(missionId);
    database.db.prepare(`
      INSERT INTO rm_findings (mission_id, id, data_json, created_at)
      VALUES (?, 'finding-1', '{}', '2026-10-29T11:43:00.000Z'),
             (?, 'finding-2', '{}', '2026-10-29T11:44:00.000Z')
    `).run(missionId, missionId);
    database.db.prepare(`
      INSERT INTO rm_capabilities (mission_id, id, data_json, updated_at)
      VALUES (?, 'capability-1', '{}', '2026-10-29T11:45:00.000Z')
    `).run(missionId);
    database.db.prepare(`
      INSERT INTO rm_evidence (mission_id, id, subject_ref, evidence_kind, collector_id, result, data_json, created_at)
      VALUES (?, 'evidence-1', 'artifact-1@1', 'file-integrity', 'fixture', 'supports', '{}', '2026-10-29T11:46:00.000Z'),
             (?, 'evidence-2', 'artifact-1@1', 'text-content', 'fixture', 'inconclusive', '{}', '2026-10-29T11:47:00.000Z')
    `).run(missionId, missionId);
    database.db.prepare(`
      INSERT INTO rm_side_effects (
        mission_id, operation_key, intent_id, source, effect_class, effect_type, target,
        status, intent_json, replay_block_count, created_at, updated_at, last_event_sequence
      ) VALUES (?, 'op-1', 'intent-1', 'host-tool', 'external-write', 'external-write', 'target',
        'succeeded', '{}', 2, '2026-10-29T11:48:00.000Z', '2026-10-29T11:49:00.000Z', 3)
    `).run(missionId);

    const summary = reader.readSummary(missionId, now);
    assert.ok(summary);
    assert.equal(summary.status, "active");
    assert.equal(summary.eventSequence, 3);
    assert.equal(summary.firstEventAt, "2026-10-29T10:00:00.000Z");
    assert.equal(summary.lastEventAt, "2026-10-29T11:58:00.000Z");
    assert.equal(summary.missionAgeMs, 2 * 60 * 60_000);
    assert.equal(summary.idleMs, 2 * 60_000);
    assert.deepEqual(summary.eventThroughput, { last5Minutes: 1, last60Minutes: 1 });
    assert.deepEqual(summary.counts.workItemsByStatus, { blocked: 1, ready: 1 });
    assert.deepEqual(summary.counts.attemptsByStatus, { running: 1, succeeded: 1 });
    assert.deepEqual(summary.counts.executionsByStatus, { completed: 2, running: 1 });
    assert.deepEqual(summary.counts.artifactsByStatus, { candidate: 1 });
    assert.deepEqual(summary.counts.gapsByStatus, { open: 1 });
    assert.deepEqual(summary.counts.approvalsByStatus, { pending: 1 });
    assert.deepEqual(summary.counts.sideEffectsByStatus, { succeeded: 1 });
    assert.deepEqual(summary.counts.evidenceByResult, { inconclusive: 1, supports: 1 });
    assert.equal(summary.counts.findings, 2);
    assert.equal(summary.counts.activeCapabilities, 1);
    assert.equal(summary.counts.sideEffectReplayBlocks, 2);
    assert.deepEqual(summary.completedExecutionLatencyMs, {
      samples: 2,
      average: 6000,
      minimum: 3000,
      maximum: 9000
    });

    assert.equal(reader.readSummary("missing-mission", now), undefined);
    assert.throws(() => reader.readSummary(missionId, new Date(Number.NaN)), /valid current time/);
  } finally {
    database.close();
  }
});
