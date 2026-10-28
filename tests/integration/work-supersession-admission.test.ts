import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function runtime() {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  return { database, store: new SqliteEventStore(database) };
}

function work(missionId: string, id: string, supersedesWorkItemRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: supersedesWorkItemRefs.length > 0 ? "repair" : "production",
    objective: id,
    status: "proposed",
    requirementRefs: ["req-1"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "acceptance", description: "deliverable exists", priority: "required" }],
    capabilityNeedRefs: [],
    ...(supersedesWorkItemRefs.length > 0 ? { supersedesWorkItemRefs: [...supersedesWorkItemRefs] } : {}),
    priority: 1,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function plannerFor(candidate: WorkItem): DeliberationProvider {
  return {
    async composeStrategy() {
      return {
        framing: "supersession admission fixture",
        approach: "validate explicit replacement relation",
        workstreams: [{ id: "stream", objective: "deliver" }],
        revision: 1
      };
    },
    async planFrontier() {
      return { graphRevision: 1, capabilityNeeds: [], workItems: [candidate] };
    },
    async diagnoseGap(input) {
      return { gapId: input.gap.id, rootCause: "fixture", intervention: "revise_work", confidence: 1 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    }
  };
}

test("frontier admission rejects a replacement that references an unknown WorkItem", async () => {
  const { database, store } = runtime();
  const missionId = "mission-supersession-unknown";
  try {
    const controller = new MissionController(store, plannerFor(work(missionId, "replacement", ["missing-work"])));
    await controller.createMission(missionId, "reject unknown replacement target");
    await assert.rejects(
      () => controller.runControllerCycle({ missionId, trigger: "mission_created" }),
      /unknown superseded WorkItem missing-work/
    );
  } finally {
    database.close();
  }
});

test("frontier admission rejects self-supersession", async () => {
  const { database, store } = runtime();
  const missionId = "mission-supersession-self";
  try {
    const controller = new MissionController(store, plannerFor(work(missionId, "replacement", ["replacement"])));
    await controller.createMission(missionId, "reject self replacement");
    await assert.rejects(
      () => controller.runControllerCycle({ missionId, trigger: "mission_created" }),
      /cannot supersede itself/
    );
  } finally {
    database.close();
  }
});

test("frontier admission rejects replacing a WorkItem that already succeeded", async () => {
  const { database, store } = runtime();
  const missionId = "mission-supersession-succeeded";
  try {
    const replacement = work(missionId, "replacement", ["successful-work"]);
    const controller = new MissionController(store, plannerFor(replacement));
    await controller.createMission(missionId, "do not erase successful Work history");
    const successful = work(missionId, "successful-work");
    successful.status = "ready";
    await controller.proposeWork(successful);
    await controller.emit(
      missionId,
      "work.completed",
      { id: successful.id, attemptId: "attempt-success", artifactRefs: ["deliverable@1"] },
      { type: "controller" },
      "successful-work-completed"
    );

    await assert.rejects(
      () => controller.runControllerCycle({ missionId, trigger: "manual" }),
      /cannot supersede WorkItem successful-work in status succeeded/
    );
  } finally {
    database.close();
  }
});
