import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function setup(provider?: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const store = new SqliteEventStore(db);
  const controller = new MissionController(store, provider);
  return { db, store, controller };
}

function work(missionId: string, id: string, purpose: WorkItem["purpose"] = "exploration", gapRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose,
    objective: `Complete ${id}`,
    status: "proposed",
    requirementRefs: [],
    gapRefs,
    inputArtifactRefs: [],
    expectedOutputs: [],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: 10,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

test("controller composes strategy and admits a frontier once", async () => {
  let strategyCalls = 0;
  let frontierCalls = 0;
  const provider: DeliberationProvider = {
    async composeStrategy() {
      strategyCalls += 1;
      return { framing: "frame", approach: "approach", workstreams: [{ id: "ws-1", objective: "produce" }], revision: 1 };
    },
    async planFrontier({ state }) {
      frontierCalls += 1;
      return { workItems: [work(state.missionId, "work-1")], graphRevision: 1 };
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "unknown", intervention: "replan_local", confidence: 0.7 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 0.9 };
    }
  };
  const { db, store, controller } = setup(provider);

  try {
    await controller.createMission("mission-plan", "produce an artifact");
    const first = await controller.runControllerCycle({ missionId: "mission-plan", trigger: "mission_created" });
    assert.deepEqual(first.workItemsCreated, ["work-1"]);
    assert.equal(strategyCalls, 1);
    assert.equal(frontierCalls, 1);

    const state = await controller.state("mission-plan");
    assert.equal(state.strategyRevision, 1);
    assert.equal(state.graphRevision, 1);
    assert.deepEqual(state.readyWorkItemIds, ["work-1"]);

    const second = await controller.runControllerCycle({ missionId: "mission-plan", trigger: "manual" });
    assert.deepEqual(second.workItemsCreated, []);
    assert.equal(strategyCalls, 1);
    assert.equal(frontierCalls, 1);

    const types = (await store.list("mission-plan")).map(event => event.type);
    assert.equal(types.filter(type => type === "strategy.created").length, 1);
    assert.equal(types.filter(type => type === "work.created").length, 1);
  } finally {
    db.close();
  }
});

test("controller diagnoses an uncovered gap before admitting repair work", async () => {
  let diagnosed = 0;
  const provider: DeliberationProvider = {
    async composeStrategy() {
      return { framing: "repair", approach: "target the verified gap", workstreams: [], revision: 1 };
    },
    async planFrontier({ state, openGaps }) {
      assert.equal(openGaps.length, 1);
      return { workItems: [work(state.missionId, "repair-1", "repair", [openGaps[0]!.id])], graphRevision: 1 };
    },
    async diagnoseGap({ gap }) {
      diagnosed += 1;
      return { gapId: gap.id, rootCause: "artifact quality failure", intervention: "revise_work", confidence: 0.95 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    }
  };
  const { db, store, controller } = setup(provider);

  try {
    await controller.createMission("mission-repair", "repair the deliverable");
    await controller.openGap("mission-repair", {
      id: "gap-quality",
      severity: "major",
      description: "quality verification failed",
      artifactRefs: ["artifact@1"]
    });

    const cycle = await controller.runControllerCycle({ missionId: "mission-repair", trigger: "verification_event" });
    assert.equal(diagnosed, 1);
    assert.deepEqual(cycle.decisionsCreated, ["gap-diagnosis:gap-quality:0"]);
    assert.deepEqual(cycle.workItemsCreated, ["repair-1"]);

    const events = await store.list("mission-repair");
    const diagnosisIndex = events.findIndex(event => event.type === "decision.created");
    const repairIndex = events.findIndex(event => event.type === "work.created");
    assert.ok(diagnosisIndex >= 0 && repairIndex > diagnosisIndex);
  } finally {
    db.close();
  }
});

test("completion challenge converts a blocking objection into a blocking gap", async () => {
  const provider: DeliberationProvider = {
    async composeStrategy() {
      return { framing: "finish", approach: "verify before completion", workstreams: [], revision: 1 };
    },
    async planFrontier() {
      throw new Error("frontier planning must not run when deterministic completion prerequisites already pass");
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "challenge", intervention: "revise_work", confidence: 1 };
    },
    async challengeCompletion() {
      return {
        blockingObjection: true,
        objections: [{
          description: "final artifact still misses a required section",
          requirementRefs: ["req-1"],
          artifactRefs: ["deliverable@1"],
          severity: "blocking"
        }],
        confidence: 0.98
      };
    }
  };
  const { db, controller } = setup(provider);

  try {
    await controller.createMission("mission-challenge-block", "finish safely");
    await controller.validateArtifact("mission-challenge-block", "deliverable@1", true);
    const cycle = await controller.runControllerCycle({ missionId: "mission-challenge-block", trigger: "verification_event" });
    assert.equal(cycle.status, "active");

    const state = await controller.state("mission-challenge-block");
    assert.equal(state.blockingGapIds.length, 1);
    assert.match(state.blockingGapIds[0]!, /^completion-objection:/);
  } finally {
    db.close();
  }
});

test("completion challenge must pass before a provider-driven mission completes", async () => {
  let challenges = 0;
  const provider: DeliberationProvider = {
    async composeStrategy() {
      return { framing: "finish", approach: "challenge completion", workstreams: [], revision: 1 };
    },
    async planFrontier() {
      throw new Error("frontier planning must not run for an eligible final artifact");
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "n/a", intervention: "replan_local", confidence: 1 };
    },
    async challengeCompletion() {
      challenges += 1;
      return { blockingObjection: false, objections: [], confidence: 0.99 };
    }
  };
  const { db, store, controller } = setup(provider);

  try {
    await controller.createMission("mission-challenge-pass", "finish only after challenge");
    await controller.validateArtifact("mission-challenge-pass", "deliverable@2", true);
    const cycle = await controller.runControllerCycle({ missionId: "mission-challenge-pass", trigger: "verification_event" });
    assert.equal(cycle.status, "completed");
    assert.equal(challenges, 1);

    const events = await store.list("mission-challenge-pass");
    const challengeDecision = events.find(event => event.type === "decision.created" && String((event.payload as { id?: string }).id).startsWith("completion-challenge:"));
    const completion = events.find(event => event.type === "mission.completed");
    assert.ok(challengeDecision);
    assert.ok(completion);
    assert.ok(challengeDecision!.sequence < completion!.sequence);
  } finally {
    db.close();
  }
});
