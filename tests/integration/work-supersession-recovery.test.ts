import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function work(
  missionId: string,
  id: string,
  status: WorkItem["status"],
  supersedesWorkItemRefs: string[] = []
): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: supersedesWorkItemRefs.length > 0 ? "repair" : "production",
    objective: id,
    status,
    requirementRefs: ["req-1"],
    gapRefs: supersedesWorkItemRefs.length > 0 ? ["gap-capability"] : [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "acceptance-1", description: "deliverable exists", priority: "required" }],
    capabilityNeedRefs: [],
    ...(supersedesWorkItemRefs.length > 0 ? { supersedesWorkItemRefs: [...supersedesWorkItemRefs] } : {}),
    priority: 1,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

test("a fresh controller reconciles durable replacement Work whose supersession transition was interrupted", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const missionId = "mission-work-supersession-restart";

  try {
    const beforeCrash = new MissionController(events, undefined, undefined, undefined, undefined, reader);
    await beforeCrash.createMission(missionId, "replace blocked Work safely after restart");
    await beforeCrash.proposeWork(work(missionId, "blocked-original", "ready"));
    await beforeCrash.emit(
      missionId,
      "work.blocked",
      { id: "blocked-original", reason: "injected capability failure" },
      { type: "controller" },
      "block-original"
    );
    await beforeCrash.openGap(missionId, {
      id: "gap-capability",
      severity: "major",
      description: "injected capability failure",
      blocking: true,
      category: "capability"
    });

    // Crash checkpoint: replacement is durable, but the controller has not yet
    // emitted the old Work's work.updated -> superseded transition.
    await beforeCrash.proposeWork(work(missionId, "replacement", "ready", ["blocked-original"]));
    let journal = await reader.journal(missionId);
    assert.equal(journal.workItems.get("blocked-original")?.status, "blocked");
    assert.equal(journal.workItems.get("replacement")?.status, "ready");
    assert.deepEqual((await beforeCrash.state(missionId)).blockedWorkItemIds, ["blocked-original"]);

    const afterRestart = new MissionController(events, undefined, undefined, undefined, undefined, reader);
    const cycle = await afterRestart.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(cycle.status, "active");

    journal = await reader.journal(missionId);
    assert.equal(journal.workItems.get("blocked-original")?.status, "superseded");
    assert.equal(journal.workItems.get("replacement")?.status, "ready");
    const state = await afterRestart.state(missionId);
    assert.deepEqual(state.blockedWorkItemIds, []);
    assert.deepEqual(state.readyWorkItemIds, ["replacement"]);

    const supersessionEvents = (await events.list(missionId)).filter(event =>
      event.type === "work.updated" &&
      (event.payload as { id?: string; status?: string }).id === "blocked-original" &&
      (event.payload as { status?: string }).status === "superseded"
    );
    assert.equal(supersessionEvents.length, 1);
    assert.equal((supersessionEvents[0]!.payload as { supersededByWorkItemId?: string }).supersededByWorkItemId, "replacement");

    // A later wake must be idempotent and not append another supersession.
    await afterRestart.runControllerCycle({ missionId, trigger: "manual" });
    const repeated = (await events.list(missionId)).filter(event =>
      event.type === "work.updated" &&
      (event.payload as { id?: string; status?: string }).id === "blocked-original" &&
      (event.payload as { status?: string }).status === "superseded"
    );
    assert.equal(repeated.length, 1);
  } finally {
    database.close();
  }
});
