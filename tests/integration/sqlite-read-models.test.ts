import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import { projectMissionState } from "../../src/core/events/state-projector.ts";
import { projectMissionJournal } from "../../src/core/mission/journal-view.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function work(missionId: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: "shared-work",
    missionId,
    purpose: "production",
    objective: `produce for ${missionId}`,
    status: "ready",
    requirementRefs: ["shared-requirement"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: 1,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function artifact(missionId: string): Artifact {
  return {
    id: "deliverable",
    missionId,
    logicalName: "deliverable",
    type: "file",
    version: 1,
    status: "candidate",
    uri: `/tmp/${missionId}/deliverable.txt`,
    contentHash: `sha256:${missionId.padEnd(64, "0").slice(0, 64)}`,
    sizeBytes: 10,
    producedByAttemptId: `attempt:${missionId}`,
    sourceArtifactRefs: [],
    createdAt: new Date().toISOString()
  };
}

async function seedMission(controller: MissionController, missionId: string) {
  await controller.createMission(missionId, `goal for ${missionId}`);
  await controller.emit(missionId, "strategy.created", {
    framing: `strategy ${missionId}`,
    approach: "progressive",
    workstreams: [{ id: "shared-stream", objective: "deliver" }],
    revision: 1
  }, { type: "planner" }, `strategy-created:${missionId}`);
  await controller.proposeWork(work(missionId));
  await controller.openGap(missionId, {
    id: "shared-gap",
    severity: "major",
    description: `gap for ${missionId}`,
    blocking: true,
    requirementRefs: ["shared-requirement"]
  });
  await controller.emit(missionId, "artifact.created", {
    artifactRef: "deliverable@1",
    artifact: artifact(missionId)
  }, { type: "worker" }, `artifact-created:${missionId}`);
  await controller.emit(missionId, "decision.created", {
    id: "shared-decision",
    missionId,
    type: "replan_local",
    targetRefs: ["shared-gap"],
    rationale: `decision for ${missionId}`,
    evidenceRefs: [],
    gapRefs: ["shared-gap"],
    requirementRefs: ["shared-requirement"],
    expectedImpact: "repair",
    confidence: 1,
    requiresApproval: false,
    status: "proposed",
    createdAt: new Date().toISOString()
  }, { type: "planner" }, `decision-created:${missionId}`);
}

test("durable read models isolate identical Mission-local ids by mission_id", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const reader = new SqliteMissionReader(database);

  try {
    await seedMission(controller, "mission-a");
    await seedMission(controller, "mission-b");

    const a = await reader.journal("mission-a");
    const b = await reader.journal("mission-b");
    assert.equal(a.workItems.get("shared-work")?.objective, "produce for mission-a");
    assert.equal(b.workItems.get("shared-work")?.objective, "produce for mission-b");
    assert.equal(a.gaps.get("shared-gap")?.description, "gap for mission-a");
    assert.equal(b.gaps.get("shared-gap")?.description, "gap for mission-b");
    assert.equal(a.artifacts.get("deliverable@1")?.missionId, "mission-a");
    assert.equal(b.artifacts.get("deliverable@1")?.missionId, "mission-b");
    assert.equal(a.decisionIds.has("shared-decision"), true);
    assert.equal(b.decisionIds.has("shared-decision"), true);

    const workRows = database.db.prepare(
      "SELECT mission_id, id FROM rm_work_items WHERE id = ? ORDER BY mission_id"
    ).all("shared-work") as Array<{ mission_id: string; id: string }>;
    assert.deepEqual(workRows.map(row => ({ mission_id: row.mission_id, id: row.id })), [
      { mission_id: "mission-a", id: "shared-work" },
      { mission_id: "mission-b", id: "shared-work" }
    ]);
    const artifactRows = database.db.prepare(
      "SELECT mission_id, id, version FROM rm_artifacts WHERE id = ? AND version = 1 ORDER BY mission_id"
    ).all("deliverable") as Array<{ mission_id: string; id: string; version: number }>;
    assert.deepEqual(artifactRows.map(row => ({ mission_id: row.mission_id, id: row.id, version: row.version })), [
      { mission_id: "mission-a", id: "deliverable", version: 1 },
      { mission_id: "mission-b", id: "deliverable", version: 1 }
    ]);
  } finally {
    database.close();
  }
});

test("read models catch up from the append-only event log after projection tables/checkpoints are removed", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const firstStore = new SqliteEventStore(database);
  const controller = new MissionController(firstStore);
  const missionId = "mission-catch-up";

  try {
    await seedMission(controller, missionId);
    const eventsBefore = await firstStore.list(missionId);
    const expectedState = projectMissionState(missionId, eventsBefore);
    const expectedJournal = projectMissionJournal(missionId, eventsBefore);

    database.db.exec(`
      DELETE FROM rm_projection_checkpoints;
      DELETE FROM rm_missions;
      DELETE FROM rm_work_items;
      DELETE FROM rm_attempts;
      DELETE FROM rm_executions;
      DELETE FROM rm_artifacts;
      DELETE FROM rm_findings;
      DELETE FROM rm_gaps;
      DELETE FROM rm_decisions;
      DELETE FROM rm_approvals;
      DELETE FROM rm_capability_needs;
      DELETE FROM rm_capabilities;
    `);

    const caughtUpStore = new SqliteEventStore(database);
    const reader = new SqliteMissionReader(database);
    assert.deepEqual(await reader.state(missionId), expectedState);

    const journal = await reader.journal(missionId);
    assert.equal(journal.userGoal, expectedJournal.userGoal);
    assert.deepEqual([...journal.workItems.entries()], [...expectedJournal.workItems.entries()]);
    assert.deepEqual([...journal.artifacts.entries()], [...expectedJournal.artifacts.entries()]);
    assert.deepEqual([...journal.gaps.entries()], [...expectedJournal.gaps.entries()]);
    assert.deepEqual([...journal.decisionIds], [...expectedJournal.decisionIds]);
    assert.equal(await caughtUpStore.lastSequence(missionId), eventsBefore.length);

    const checkpoint = database.db.prepare(
      "SELECT event_sequence FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).get("mission-read-model-v1", missionId) as { event_sequence: number };
    assert.equal(checkpoint.event_sequence, eventsBefore.length);
  } finally {
    database.close();
  }
});

test("projection failure rolls back the Mission event insert atomically", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const missionId = "mission-projection-rollback";

  try {
    await assert.rejects(
      events.append({
        id: "bad-work-update",
        missionId,
        type: "work.updated",
        actor: { type: "controller" },
        payload: { id: "missing-work", status: "running" },
        idempotencyKey: "bad-work-update",
        schemaVersion: 1,
        createdAt: new Date().toISOString()
      }, 0),
      /Read-model WorkItem not found/
    );
    assert.equal(await events.lastSequence(missionId), 0);
    assert.deepEqual(await events.list(missionId), []);
    const checkpoint = database.db.prepare(
      "SELECT event_sequence FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).get("mission-read-model-v1", missionId);
    assert.equal(checkpoint, undefined);
  } finally {
    database.close();
  }
});
