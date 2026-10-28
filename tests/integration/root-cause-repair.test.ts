import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function setup(deliberation: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  return { db, events, projections, controller: new MissionController(events, { projections, deliberation }) };
}

function baseProvider(overrides: Partial<DeliberationProvider>): DeliberationProvider {
  return {
    async composeStrategy({ state }) {
      return { framing: "repair", approach: "progressive", workstreams: [], revision: (state.strategyRevision ?? 0) + 1 };
    },
    async planFrontier({ state }) {
      return { graphRevision: state.graphRevision + 1, workItems: [], capabilityNeeds: [] };
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", repairScope: "work_item", confidence: 0.9 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    },
    ...overrides
  };
}

async function addFindingAndEvidence(controller: MissionController, missionId: string, gapId: string) {
  const now = new Date().toISOString();
  await controller.recordEvidence(missionId, {
    id: "e-root", missionId, subjectRef: "deck@1", type: "render-inspection", claim: "render shows overflow", result: "contradicts", createdAt: now
  });
  await controller.emit(missionId, "finding.created", { finding: {
    id: "f-root", missionId, artifactRef: "deck@1", category: "visual", severity: "major",
    observation: "text overflows the slide", expected: "all text remains in bounds", requirementRefs: [], evidenceRefs: ["e-root"],
    confidence: 0.98, checkId: "visual-overflow", reproducible: true, createdAt: now
  } }, { type: "verifier" }, `finding:${gapId}:f-root`);
  await controller.openGap(missionId, { id: gapId, severity: "major", description: "deck text overflow", artifactRefs: ["deck@1"], findingRefs: ["f-root"] });
}

test("diagnosis receives durable findings/evidence and caps unsupported broad repair", async () => {
  let observed: any;
  const provider = baseProvider({
    async diagnoseGap(input) {
      observed = input;
      return {
        gapId: input.gap.id,
        rootCause: "possible theme geometry mismatch",
        intervention: "revise_strategy",
        repairScope: "strategy",
        confidence: 0.55,
        evidenceRefs: ["e-root"],
        hypotheses: [{ statement: "possible theme geometry mismatch", confidence: 0.55, findingRefs: ["f-root"], evidenceRefs: ["e-root"] }]
      };
    }
  });
  const { db, events, projections, controller } = setup(provider);
  await controller.createMission("m-root-cap", "repair the deck");
  await addFindingAndEvidence(controller, "m-root-cap", "g-root");
  const cycle = await controller.runControllerCycle({ missionId: "m-root-cap", trigger: "verification_event" });
  assert.equal(observed.findings.length, 1);
  assert.equal(observed.findings[0].id, "f-root");
  assert.equal(observed.evidence.length, 1);
  assert.equal(observed.evidence[0].id, "e-root");
  assert.deepEqual(cycle.workItemsCreated, ["repair-g-root"]);
  const decisionEvent = (await events.list("m-root-cap")).find(event => event.type === "decision.created");
  assert.equal((decisionEvent?.payload as any).decision.type, "revise_work");
  assert.equal((decisionEvent?.payload as any).diagnosis.repairScope, "work_item");
  assert.ok((await projections.listWorkItems("m-root-cap")).some(work => work.id === "repair-g-root"));
  db.close();
});

test("a recurring gap creates a new repair attempt and does not repeat transient retry", async () => {
  let calls = 0;
  const provider = baseProvider({
    async diagnoseGap({ gap }) {
      calls += 1;
      return calls === 1
        ? { gapId: gap.id, rootCause: "bad local layout", intervention: "revise_work", repairScope: "work_item", confidence: 0.9 }
        : { gapId: gap.id, rootCause: "retry the same operation", intervention: "retry", repairScope: "attempt", confidence: 0.9 };
    }
  });
  const { db, events, controller } = setup(provider);
  await controller.createMission("m-repeat-repair", "repair until verified");
  await controller.openGap("m-repeat-repair", { id: "g-repeat", severity: "major", description: "artifact still fails" });
  const first = await controller.runControllerCycle({ missionId: "m-repeat-repair", trigger: "verification_event" });
  assert.deepEqual(first.workItemsCreated, ["repair-g-repeat"]);
  await controller.emit("m-repeat-repair", "work.completed", { id: "repair-g-repeat" }, { type: "worker" });
  const second = await controller.runControllerCycle({ missionId: "m-repeat-repair", trigger: "verification_event" });
  assert.deepEqual(second.workItemsCreated, ["repair-g-repeat-2"]);
  const decisions = (await events.list("m-repeat-repair")).filter(event => event.type === "decision.created");
  assert.equal((decisions.at(-1)?.payload as any).decision.type, "revise_work");
  assert.equal((decisions.at(-1)?.payload as any).diagnosis.repairScope, "work_item");
  db.close();
});

test("high-confidence evidence-backed strategy repair revises strategy and replans instead of creating a generic repair", async () => {
  let composeCalls = 0;
  const provider = baseProvider({
    async composeStrategy({ state }) {
      composeCalls += 1;
      return { framing: `repair-${composeCalls}`, approach: "reframe", workstreams: [], revision: (state.strategyRevision ?? 0) + 1 };
    },
    async diagnoseGap({ gap }) {
      return {
        gapId: gap.id,
        rootCause: "the current strategy selected the wrong artifact architecture",
        intervention: "revise_strategy",
        repairScope: "strategy",
        confidence: 0.95,
        evidenceRefs: ["e-root"],
        hypotheses: [{ statement: "the current strategy selected the wrong artifact architecture", confidence: 0.95, findingRefs: ["f-root"], evidenceRefs: ["e-root"] }]
      };
    },
    async planFrontier({ state, openGaps }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        capabilityNeeds: [],
        workItems: [{
          id: "w-strategy-fix", missionId: state.missionId, purpose: "repair", objective: "implement the revised strategy",
          status: "ready", requirementRefs: [], gapRefs: [openGaps[0]!.id], inputArtifactRefs: ["deck@1"], expectedOutputs: [],
          localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: state.graphRevision + 1,
          createdBy: "replanner", createdAt: now, updatedAt: now
        }]
      };
    }
  });
  const { db, projections, controller } = setup(provider);
  await controller.createMission("m-strategy-repair", "repair strategy-level failure");
  await addFindingAndEvidence(controller, "m-strategy-repair", "g-strategy");
  const cycle = await controller.runControllerCycle({ missionId: "m-strategy-repair", trigger: "verification_event" });
  assert.deepEqual(cycle.workItemsCreated, ["w-strategy-fix"]);
  assert.equal((await controller.state("m-strategy-repair")).strategyRevision, 2);
  assert.ok((await projections.listWorkItems("m-strategy-repair")).some(work => work.id === "w-strategy-fix"));
  assert.ok(!(await projections.listWorkItems("m-strategy-repair")).some(work => work.id.startsWith("repair-g-strategy")));
  db.close();
});
