import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["one", "two"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [
            { id: "R1", description: "first artifact", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] },
            { id: "R2", description: "second artifact", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }
          ],
          requiredArtifacts: [
            { logicalName: "one", type: "document", requirementRefs: ["R1"] },
            { logicalName: "two", type: "document", requirementRefs: ["R2"] }
          ], requiredValidations: [], criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "budgeted", approach: "finish within explicit limits", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 0.8 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

function work(missionId: string, id: string, requirement: string, logicalName: string, createdAt: string): WorkItem {
  return {
    id, missionId, purpose: "production", objective: `produce ${logicalName}`, status: "ready",
    requirementRefs: [requirement], gapRefs: [], inputArtifactRefs: [],
    expectedOutputs: [{ logicalName, type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [],
    priority: 50, graphRevision: 1, createdBy: "planner", createdAt, updatedAt: createdAt
  };
}

test("attempt hard budget reserves dispatch capacity and a higher budget revision resumes the mission", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-budget-"));
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      const context = request.context as any;
      const output = context.expectedOutputs[0];
      writeFileSync(join(request.workspaceRoot!, `${output.logicalName}.txt`), `${output.logicalName}\n`, "utf8");
      return { text: JSON.stringify({
        status: "completed", summary: `produced ${output.logicalName}`,
        outputs: [{ path: `${output.logicalName}.txt`, logicalName: output.logicalName, type: "document", requirementRefs: context.requirements.map((r: any) => r.id) }],
        proposedFacts: [], proposedWork: [], warnings: []
      }) };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider(), maxConcurrency: 4 });
  const missionId = "m-budget";
  await runtime.controller.createMission(missionId, "produce two artifacts under an attempt budget");
  await runtime.configureBudget({
    missionId, revision: 1, createdAt: new Date().toISOString(),
    limits: [{ metric: "attempts", limit: 1, enforcement: "hard" }]
  });
  const now = new Date().toISOString();
  await runtime.controller.proposeWork(work(missionId, "w1", "R1", "one", now));
  await runtime.controller.proposeWork(work(missionId, "w2", "R2", "two", now));

  await runtime.orchestrator!.runUntilQuiescent(missionId);
  assert.equal(host.agentRequests.length, 1);
  assert.equal((await runtime.controller.state(missionId)).status, "budget_exhausted");
  assert.equal((await runtime.events.list(missionId)).filter(event => event.type === "attempt.created").length, 1);
  assert.equal((await runtime.projections.listArtifacts(missionId)).length, 1);

  await runtime.configureBudget({
    missionId, revision: 2, createdAt: new Date().toISOString(),
    limits: [{ metric: "attempts", limit: 2, enforcement: "hard" }]
  });
  assert.equal((await runtime.controller.state(missionId)).status, "active");
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  assert.equal(host.agentRequests.length, 2);
  assert.equal((await runtime.events.list(missionId)).filter(event => event.type === "attempt.created").length, 2);
  assert.equal((await runtime.controller.state(missionId)).status, "completed");
  runtime.close();
});

test("scoped acquisition and side-effect budgets do not block read-only production", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-budget-scoped-"));
  const runtime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter(), deliberation: provider() });
  const missionId = "m-budget-scoped";
  await runtime.controller.createMission(missionId, "test scoped budgets");
  await runtime.configureBudget({
    missionId, revision: 1, createdAt: new Date().toISOString(),
    limits: [
      { metric: "attempts", limit: 5, enforcement: "hard" },
      { metric: "capability_acquisitions", limit: 0, enforcement: "hard" },
      { metric: "external_side_effects", limit: 0, enforcement: "hard" },
      { metric: "concurrent_executions", limit: 1, enforcement: "hard" }
    ]
  });
  const assessment = await runtime.budget.assess(missionId);
  const reservation = runtime.budget.emptyReservation();
  const now = new Date().toISOString();
  const production = work(missionId, "prod", "R1", "one", now);
  const acquisition: WorkItem = { ...production, id: "acq", purpose: "acquisition", objective: "acquire tool", requirementRefs: [], capabilityNeedRefs: ["need-1"] };
  assert.equal(runtime.budget.canReserve(production, assessment, reservation, { requiresApproval: false }), true);
  assert.equal(runtime.budget.canReserve(acquisition, assessment, reservation), false);
  assert.equal(runtime.budget.canReserve(production, assessment, reservation, { requiresApproval: true }), false);
  runtime.close();
});
