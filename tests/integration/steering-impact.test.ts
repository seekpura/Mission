import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";

function setup(kind: "semantic" | "operational" = "semantic") {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const deliberation: DeliberationProvider = {
    async interpretSteering() {
      return kind === "operational" ? {
        kind: "operational", reason: "continue current mission", confidence: 1, affectedRequirementRefs: [], affectedWorkItemRefs: [], affectedArtifactRefs: [], strategyImpact: "none"
      } : {
        kind: "semantic", reason: "make technical narrative deeper", confidence: 0.95,
        specPatch: { preferences: ["technical depth over marketing tone"] },
        affectedRequirementRefs: ["r-tech"], affectedWorkItemRefs: [], affectedArtifactRefs: [], strategyImpact: "local"
      };
    },
    async composeStrategy() { return { framing: "technical", approach: "progressive", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 0.8 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  return { db, projections, controller: new MissionController(events, { projections, deliberation }) };
}

function work(missionId: string, id: string, requirementRefs: string[], inputs: string[] = [], output?: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId, purpose: "production", objective: id, status: "ready", requirementRefs, gapRefs: [], inputArtifactRefs: inputs,
    expectedOutputs: output ? [{ logicalName: output, type: "file", required: true }] : [], localAcceptanceCriteria: [], capabilityNeedRefs: [],
    priority: 50, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}

async function seed(controller: MissionController, missionId: string) {
  await controller.createMission(missionId, "build a technical keynote");
  const now = new Date().toISOString();
  await controller.emit(missionId, "acceptance.revised", { revision: 2, contract: {
    missionId, revision: 2, createdAt: now,
    requirements: [
      { id: "r-tech", description: "technical narrative", type: "content", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] },
      { id: "r-source", description: "source appendix", type: "evidence", priority: "required", verification: "evidence", status: "unverified", evidenceRefs: [] }
    ], requiredArtifacts: [], requiredValidations: [], criticalFailureConditions: []
  } }, { type: "controller" });
  await controller.proposeWork(work(missionId, "w-tech", ["r-tech"], [], "deck"));
  await controller.proposeWork(work(missionId, "w-source", ["r-source"], [], "sources"));
  await controller.proposeWork(work(missionId, "w-integrate", [], ["deck@1"], "final"));
  const deck: Artifact = { id: "deck", missionId, logicalName: "deck", type: "presentation", version: 1, status: "verified", uri: "/tmp/deck.pptx", contentHash: "a", producedByAttemptId: "a1", sourceArtifactRefs: [], createdAt: now };
  const preview: Artifact = { id: "preview", missionId, logicalName: "preview", type: "image", version: 1, status: "verified", uri: "/tmp/preview.png", contentHash: "b", producedByAttemptId: "a2", sourceArtifactRefs: ["deck@1"], createdAt: now };
  await controller.recordArtifact(missionId, deck); await controller.recordArtifact(missionId, preview);
}

test("semantic steering invalidates only affected work and artifact lineage while preserving unrelated frontier", async () => {
  const { db, projections, controller } = setup("semantic");
  await seed(controller, "m-steer");
  const before = await projections.getMissionSpec("m-steer");
  const result = await controller.steerWithImpact("m-steer", "less marketing, more technical depth");
  assert.equal(result.impact.kind, "semantic");
  assert.deepEqual(new Set(result.impact.invalidatedWorkItemRefs), new Set(["w-tech", "w-integrate"]));
  assert.deepEqual(result.impact.unaffectedActiveWorkItemRefs, ["w-source"]);
  assert.deepEqual(new Set(result.impact.invalidatedArtifactRefs), new Set(["deck@1", "preview@1"]));
  const after = await projections.getMissionSpec("m-steer");
  assert.equal(after?.revision, (before?.revision ?? 0) + 1);
  assert.deepEqual(after?.preferences, ["technical depth over marketing tone"]);
  const works = await projections.listWorkItems("m-steer");
  assert.equal(works.find(item => item.id === "w-tech")?.status, "invalidated");
  assert.equal(works.find(item => item.id === "w-integrate")?.status, "invalidated");
  assert.equal(works.find(item => item.id === "w-source")?.status, "ready");
  const artifacts = await projections.listArtifacts("m-steer");
  assert.equal(artifacts.find(item => item.id === "deck")?.status, "invalid");
  assert.equal(artifacts.find(item => item.id === "preview")?.status, "invalid");
  db.close();
});

test("operational steering records direction without revising mission or invalidating work", async () => {
  const { db, projections, controller } = setup("operational");
  await seed(controller, "m-continue");
  const before = await projections.getMissionSpec("m-continue");
  const result = await controller.steerWithImpact("m-continue", "continue");
  const after = await projections.getMissionSpec("m-continue");
  assert.equal(result.impact.kind, "operational");
  assert.equal(after?.revision, before?.revision);
  assert.deepEqual(result.impact.invalidatedWorkItemRefs, []);
  assert.equal((await projections.listWorkItems("m-continue")).filter(item => item.status === "ready").length, 3);
  db.close();
});
