import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deliverable"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "deliverable exists and is valid", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
          requiredValidations: [{ id: "structural", description: "structural validation", level: "structural", requirementRefs: ["R1"] }],
          criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "direct", approach: "produce and verify", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision + 1 }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections, deliberation: provider() });
  return { db, projections, controller };
}

test("hard completion gate refuses a final artifact until required Requirement evidence is satisfied", async () => {
  const { db, projections, controller } = setup();
  await controller.createMission("m-accept", "produce a verified deliverable");
  const contract = await projections.getAcceptanceContract("m-accept");
  assert.equal(contract?.requirements[0]?.id, "R1");
  assert.equal((await projections.listRequirements("m-accept"))[0]?.status, "unverified");

  await controller.validateArtifact("m-accept", "deliverable@1", true);
  let state = await controller.completeIfEligible("m-accept");
  assert.notEqual(state.status, "completed");

  const evidence = {
    id: "E1", missionId: "m-accept", subjectRef: "deliverable@1", type: "file-validation" as const,
    claim: "deliverable is structurally valid", result: "supports" as const, createdAt: new Date().toISOString()
  };
  await controller.recordEvidence("m-accept", evidence);
  await controller.setRequirementStatus("m-accept", "R1", "satisfied", ["E1"]);
  state = await controller.completeIfEligible("m-accept");
  assert.notEqual(state.status, "completed", "required artifact/validation must also exist in durable projections");
  db.close();
});
