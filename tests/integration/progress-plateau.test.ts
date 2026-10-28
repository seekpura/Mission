import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionReadModel } from "../../src/core/mission/mission-read-model.ts";
import { MissionProgressTracker } from "../../src/core/progress/progress-tracker.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup(deliberation?: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections, deliberation });
  return { db, projections, events, controller, tracker: new MissionProgressTracker(events, new MissionReadModel(events, projections)) };
}

function repair(missionId: string, id: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId, purpose: "repair", objective: "repair persistent gap", status: "failed", requirementRefs: ["r1"], gapRefs: ["g1"], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1, createdBy: "replanner", createdAt: now, updatedAt: now };
}

test("progress tracker suspends plateau while legitimate ready work exists", async () => {
  const { db, controller, tracker } = setup();
  await controller.createMission("m-waiting", "deliver artifact");
  await controller.openGap("m-waiting", { id: "g1", severity: "major", description: "broken" });
  const now = new Date().toISOString();
  await controller.proposeWork({ ...repair("m-waiting", "repair-g1"), status: "ready", createdAt: now, updatedAt: now });
  const state = await controller.state("m-waiting");
  const snapshot = await tracker.snapshot("m-waiting", state);
  const assessment = await tracker.assess("m-waiting", state, snapshot);
  assert.equal(assessment.state, "waiting");
  assert.equal(assessment.context.waitingReason, "ready-work");
  db.close();
});

test("controller reports plateau only after sustained no-progress and a strategy repair has already failed", async () => {
  let lastPlateauContext: any;
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "stuck", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap(input) { lastPlateauContext = input.plateauContext; return { gapId: input.gap.id, rootCause: "persistent system mismatch", intervention: "revise_strategy", repairScope: "strategy", confidence: 0.95, evidenceRefs: ["ev1", "ev2"] }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  const { db, controller, events, tracker } = setup(deliberation);
  await controller.createMission("m-plateau", "deliver artifact");
  await controller.recordEvidence("m-plateau", { id: "ev1", missionId: "m-plateau", subjectRef: "g1", type: "test-result", claim: "repair failed", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.recordEvidence("m-plateau", { id: "ev2", missionId: "m-plateau", subjectRef: "g1", type: "runtime-check", claim: "strategy repair failed", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.openGap("m-plateau", { id: "g1", severity: "major", description: "persistent blocker", evidenceRefs: ["ev1", "ev2"] } as any);
  for (let i = 1; i <= 4; i++) await controller.proposeWork(repair("m-plateau", `repair-g1-${i}`));
  await controller.emit("m-plateau", "decision.created", { decision: { id: "d-strategy", missionId: "m-plateau", type: "revise_strategy", targetRefs: ["g1"], rationale: "strategy repair", evidenceRefs: ["ev1", "ev2"], gapRefs: ["g1"], requirementRefs: [], confidence: 0.95, requiresApproval: false, status: "applied", createdAt: new Date().toISOString() } }, { type: "controller" });
  const state = await controller.state("m-plateau");
  const snapshot = await tracker.snapshot("m-plateau", state);
  for (let i = 0; i < 4; i++) await controller.emit("m-plateau", "progress.observed", { snapshot: { ...snapshot, observedAt: new Date(Date.now() + i).toISOString() } }, { type: "controller" });
  const cycle = await controller.runControllerCycle({ missionId: "m-plateau", trigger: "verification_event" });
  assert.equal(cycle.status, "plateau");
  const after = await controller.state("m-plateau");
  assert.equal(after.status, "plateau");
  assert.ok((await events.list("m-plateau")).some(event => event.type === "mission.status.changed" && (event.payload as any).status === "plateau"));
  assert.equal(lastPlateauContext, undefined, "once plateau is established no new diagnosis/repair should be dispatched");
  db.close();
});

test("stalled progress is passed into diagnosis before plateau so repair can escalate with evidence", async () => {
  let captured: any;
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "stalled", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap(input) { captured = input.plateauContext; return { gapId: input.gap.id, rootCause: "executor mismatch", intervention: "replace_executor", repairScope: "executor", confidence: 0.9, evidenceRefs: ["ev1"] }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  const { db, controller, tracker } = setup(deliberation);
  await controller.createMission("m-stalled", "deliver artifact");
  await controller.recordEvidence("m-stalled", { id: "ev1", missionId: "m-stalled", subjectRef: "g1", type: "test-result", claim: "same executor repeatedly fails", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.openGap("m-stalled", { id: "g1", severity: "major", description: "persistent blocker", findingRefs: [], requirementRefs: [], artifactRefs: [] });
  const state = await controller.state("m-stalled");
  const snapshot = await tracker.snapshot("m-stalled", state);
  await controller.emit("m-stalled", "progress.observed", { snapshot }, { type: "controller" });
  await controller.emit("m-stalled", "progress.observed", { snapshot: { ...snapshot, observedAt: new Date().toISOString() } }, { type: "controller" });
  const cycle = await controller.runControllerCycle({ missionId: "m-stalled", trigger: "verification_event" });
  assert.ok(captured);
  assert.ok(captured.stagnationCount >= 3);
  assert.equal(cycle.status, "active");
  db.close();
});
