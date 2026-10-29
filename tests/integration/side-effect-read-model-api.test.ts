import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type {
  SideEffectAdmission,
  SideEffectCompletion,
  SideEffectIntent
} from "../../src/core/domain/execution.ts";
import type { MissionEventType } from "../../src/core/domain/event.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function schemaPath() {
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

async function append(
  events: SqliteEventStore,
  missionId: string,
  type: MissionEventType,
  payload: SideEffectIntent | SideEffectAdmission | SideEffectCompletion,
  createdAt: string
): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const committed = await events.append({
    id: `event-${expected + 1}`,
    missionId,
    type,
    actor: { type: "system", id: "side-effect-fixture" },
    payload,
    schemaVersion: 1,
    createdAt
  }, expected);
  return committed.sequence;
}

function intent(
  missionId: string,
  operationKey: string,
  executionId: string,
  workItemId: string,
  createdAt: string
): SideEffectIntent {
  return {
    id: `intent-${operationKey}`,
    missionId,
    workItemId,
    attemptId: `attempt-${executionId}`,
    executionId,
    source: "host-tool",
    operationKey,
    fingerprint: `fingerprint-${operationKey}`,
    effectClass: "external-write",
    type: "external-write",
    target: `https://example.invalid/${operationKey}`,
    reversible: true,
    description: `write ${operationKey}`,
    createdAt
  };
}

function admission(
  value: SideEffectIntent,
  status: SideEffectAdmission["status"],
  decidedAt: string
): SideEffectAdmission {
  return {
    intentId: value.id,
    operationKey: value.operationKey,
    status,
    reason: `fixture ${status}`,
    approvalRequired: status === "admitted",
    decidedAt
  };
}

function completion(
  value: SideEffectIntent,
  status: SideEffectCompletion["status"],
  completedAt: string
): SideEffectCompletion {
  return {
    intentId: value.id,
    operationKey: value.operationKey,
    status,
    detail: `fixture ${status}`,
    completedAt
  };
}

test("side-effect read model preserves operation state, replay blocks and bounded API filters", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const server = createMissionApi(controller, events, { sideEffectReader: reader });
  const missionId = "mission-side-effect-read-model";
  const first = intent(missionId, "op-1", "execution-1", "work-1", "2026-10-29T03:00:00.000Z");
  const second = intent(missionId, "op-2", "execution-2", "work-2", "2026-10-29T03:10:00.000Z");

  try {
    await controller.createMission(missionId, "observe durable side effects");
    await append(events, missionId, "side_effect.intent.recorded", first, first.createdAt);
    await append(events, missionId, "side_effect.admitted", admission(first, "admitted", "2026-10-29T03:01:00.000Z"), "2026-10-29T03:01:00.000Z");
    await append(events, missionId, "side_effect.completed", completion(first, "succeeded", "2026-10-29T03:02:00.000Z"), "2026-10-29T03:02:00.000Z");
    const firstReplaySequence = await append(
      events,
      missionId,
      "side_effect.replay_blocked",
      admission(first, "replay_blocked", "2026-10-29T03:03:00.000Z"),
      "2026-10-29T03:03:00.000Z"
    );
    await append(events, missionId, "side_effect.intent.recorded", second, second.createdAt);
    await append(events, missionId, "side_effect.denied", admission(second, "denied", "2026-10-29T03:11:00.000Z"), "2026-10-29T03:11:00.000Z");

    const all = reader.readSideEffects(missionId);
    assert.equal(all.length, 2);
    assert.equal(all[0]?.operationKey, "op-1");
    assert.equal(all[0]?.status, "succeeded");
    assert.equal(all[0]?.admission?.status, "admitted");
    assert.equal(all[0]?.replayBlockCount, 1);
    assert.equal(all[0]?.lastReplayBlocked?.status, "replay_blocked");
    assert.equal(all[0]?.completion?.status, "succeeded");
    assert.equal(all[1]?.status, "denied");

    assert.deepEqual(
      reader.readSideEffects(missionId, { executionId: "execution-2" }).map(view => view.operationKey),
      ["op-2"]
    );
    assert.deepEqual(
      reader.readSideEffects(missionId, { status: "succeeded" }).map(view => view.operationKey),
      ["op-1"]
    );
    assert.deepEqual(
      reader.readSideEffects(missionId, { afterSequence: firstReplaySequence }).map(view => view.operationKey),
      ["op-2"]
    );

    const base = await listen(server);
    const filtered = await fetch(`${base}/missions/${missionId}/side-effects?status=succeeded&limit=1`);
    assert.equal(filtered.status, 200);
    const filteredBody = await filtered.json() as Array<{ operationKey: string; replayBlockCount: number }>;
    assert.deepEqual(filteredBody.map(value => value.operationKey), ["op-1"]);
    assert.equal(filteredBody[0]?.replayBlockCount, 1);

    const byExecution = await fetch(`${base}/missions/${missionId}/side-effects?executionId=execution-2`);
    assert.equal(byExecution.status, 200);
    const byExecutionBody = await byExecution.json() as Array<{ operationKey: string }>;
    assert.deepEqual(byExecutionBody.map(value => value.operationKey), ["op-2"]);

    const invalidStatus = await fetch(`${base}/missions/${missionId}/side-effects?status=replay_blocked`);
    assert.equal(invalidStatus.status, 400);
    const invalidLimit = await fetch(`${base}/missions/${missionId}/side-effects?limit=501`);
    assert.equal(invalidLimit.status, 400);
  } finally {
    await closeServer(server);
    database.close();
  }
});

test("side-effect projection rebuilds from Mission events and rejects orphan terminal state transactionally", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  let events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const missionId = "mission-side-effect-rebuild";
  const value = intent(missionId, "rebuild-op", "execution-rebuild", "work-rebuild", "2026-10-29T04:00:00.000Z");

  try {
    await controller.createMission(missionId, "rebuild side-effect operations");
    await append(events, missionId, "side_effect.intent.recorded", value, value.createdAt);
    await append(events, missionId, "side_effect.admitted", admission(value, "admitted", "2026-10-29T04:01:00.000Z"), "2026-10-29T04:01:00.000Z");
    await append(events, missionId, "side_effect.completed", completion(value, "unknown", "2026-10-29T04:02:00.000Z"), "2026-10-29T04:02:00.000Z");
    const before = reader.readSideEffects(missionId);
    assert.equal(before[0]?.status, "unknown");

    database.db.prepare("DELETE FROM rm_side_effects WHERE mission_id = ?").run(missionId);
    database.db.prepare(
      "DELETE FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).run("side-effect-read-model-v1", missionId);

    events = new SqliteEventStore(database);
    const rebuilt = reader.readSideEffects(missionId);
    assert.deepEqual(rebuilt, before);

    const sequenceBeforeOrphan = await events.lastSequence(missionId);
    const orphanCompletion: SideEffectCompletion = {
      intentId: "missing-intent",
      operationKey: "missing-operation",
      status: "failed",
      completedAt: "2026-10-29T04:03:00.000Z"
    };
    await assert.rejects(
      () => append(events, missionId, "side_effect.failed", orphanCompletion, orphanCompletion.completedAt),
      /references unknown intent/
    );
    assert.equal(await events.lastSequence(missionId), sequenceBeforeOrphan);
  } finally {
    database.close();
  }
});
