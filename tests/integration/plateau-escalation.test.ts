import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionReadModel } from "../../src/core/mission/mission-read-model.ts";
import { MissionProgressTracker } from "../../src/core/progress/progress-tracker.ts";
import { normalizeGapDiagnosis } from "../../src/core/planning/repair-scope-policy.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

test("repair scope policy raises a weak repeated retry to the deterministic stalled-progress floor", () => {
  const normalized = normalizeGapDiagnosis({
    gapId: "g1",
    rootCause: "same attempt keeps failing",
    intervention: "retry",
    repairScope: "attempt",
    confidence: 0.9,
    evidenceRefs: ["ev1"]
  }, {
    evidenceRefs: ["ev1"],
    priorRepairCount: 2,
    minimumRepairScope: "executor"
  });
  assert.equal(normalized.repairScope, "executor");
  assert.equal(normalized.intervention, "replace_executor");
});

test("controller escalates stalled work beyond the highest previously attempted repair scope", async () => {
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "repair", approach: "progressive", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap() {
      return {
        gapId: "g1",
        rootCause: "retry the same worker",
        intervention: "retry",
        repairScope: "attempt",
        confidence: 0.95,
        evidenceRefs: ["ev1"]
      };
    },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };

  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections, deliberation });
  const tracker = new MissionProgressTracker(events, new MissionReadModel(events, projections));

  await controller.createMission("m-escalate", "deliver a valid artifact");
  await controller.recordEvidence("m-escalate", {
    id: "ev1", missionId: "m-escalate", subjectRef: "g1", type: "test-result",
    claim: "work-item repair made no acceptance progress", result: "contradicts", createdAt: new Date().toISOString()
  });
  await controller.openGap("m-escalate", { id: "g1", severity: "major", description: "persistent blocker", requirementRefs: ["r1"] });

  const now = new Date().toISOString();
  const priorRepair: WorkItem = {
    id: "repair-g1", missionId: "m-escalate", purpose: "repair", objective: "revise failed work",
    status: "failed", requirementRefs: ["r1"], gapRefs: ["g1"], inputArtifactRefs: [], expectedOutputs: [],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1,
    createdBy: "replanner", createdAt: now, updatedAt: now
  };
  await controller.proposeWork(priorRepair);
  await controller.emit("m-escalate", "decision.created", { decision: {
    id: "d-work", missionId: "m-escalate", type: "revise_work", targetRefs: ["g1"], rationale: "first repair",
    evidenceRefs: ["ev1"], gapRefs: ["g1"], requirementRefs: ["r1"], confidence: 0.9,
    requiresApproval: false, status: "applied", createdAt: now
  } }, { type: "controller" });

  const state = await controller.state("m-escalate");
  const snapshot = await tracker.snapshot("m-escalate", state);
  await controller.emit("m-escalate", "progress.observed", { snapshot }, { type: "controller" });
  await controller.emit("m-escalate", "progress.observed", { snapshot: { ...snapshot, observedAt: new Date(Date.now() + 1).toISOString() } }, { type: "controller" });

  await controller.runControllerCycle({ missionId: "m-escalate", trigger: "verification_event" });

  const createdDecisions = (await events.list("m-escalate"))
    .filter(event => event.type === "decision.created")
    .map(event => (event.payload as any).decision);
  const escalated = createdDecisions.find(decision => decision.id !== "d-work");
  assert.equal(escalated?.type, "replace_executor");
  const repairs = (await projections.listWorkItems("m-escalate")).filter(work => work.purpose === "repair");
  const latest = repairs.find(work => work.id !== "repair-g1");
  assert.ok(latest);
  assert.equal(latest?.executionConstraints?.forceFreshAgent, true);
  db.close();
});
