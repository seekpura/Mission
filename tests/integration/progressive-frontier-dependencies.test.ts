import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function work(missionId: string, graphRevision: number, input: Partial<WorkItem> & Pick<WorkItem, "id" | "objective" | "requirementRefs" | "expectedOutputs">): WorkItem {
  const now = new Date().toISOString();
  return {
    id: input.id,
    missionId,
    purpose: input.purpose ?? "production",
    objective: input.objective,
    status: "ready",
    requirementRefs: input.requirementRefs,
    gapRefs: input.gapRefs ?? [],
    inputArtifactRefs: input.inputArtifactRefs ?? [],
    artifactDependencies: input.artifactDependencies,
    expectedOutputs: input.expectedOutputs,
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: input.priority ?? 50,
    graphRevision,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

test("scheduler waits for verified artifact dependencies and planner continues rolling frontier after partial final artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-progressive-deps-"));
  const missionId = "m-progressive-deps";
  let planCalls = 0;
  const provider: DeliberationProvider = {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      const requirements = [
        { id: "R-SOURCE", description: "source record exists", type: "functional" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: "R-DECK", description: "deck exists", type: "functional" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: "R-NOTES", description: "speaker notes exist", type: "functional" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] }
      ];
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["source-record", "deck", "speaker-notes"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1, requirements,
          requiredArtifacts: [
            { logicalName: "source-record", type: "document", requirementRefs: ["R-SOURCE"] },
            { logicalName: "deck", type: "presentation", requirementRefs: ["R-DECK"] },
            { logicalName: "speaker-notes", type: "document", requirementRefs: ["R-NOTES"] }
          ],
          requiredValidations: [], criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "rolling", approach: "source then deck then notes", workstreams: [{ id: "keynote", objective: "deliver keynote" }], revision: 1 }; },
    async planFrontier({ state }) {
      planCalls += 1;
      const revision = state.graphRevision + 1;
      if (planCalls === 1) return {
        graphRevision: revision,
        workItems: [
          work(state.missionId, revision, { id: "research", objective: "produce source record", requirementRefs: ["R-SOURCE"], expectedOutputs: [{ logicalName: "source-record", type: "document", required: true }], priority: 80 }),
          work(state.missionId, revision, { id: "deck", objective: "produce deck from verified source record", requirementRefs: ["R-DECK"], artifactDependencies: [{ logicalName: "source-record", type: "document", minimumStatus: "final" }], expectedOutputs: [{ logicalName: "deck", type: "presentation", required: true }], priority: 100 })
        ]
      };
      if (planCalls === 2) return {
        graphRevision: revision,
        workItems: [work(state.missionId, revision, { id: "notes", objective: "produce speaker notes after deck", requirementRefs: ["R-NOTES"], artifactDependencies: [{ logicalName: "deck", type: "presentation", minimumStatus: "final" }], expectedOutputs: [{ logicalName: "speaker-notes", type: "document", required: true }], priority: 90 })]
      };
      return { graphRevision: state.graphRevision, workItems: [] };
    },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", repairScope: "work_item", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };

  const executionOrder: string[] = [];
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      executionOrder.push(request.workItemId);
      const outputs: Record<string, { file: string; logicalName: string; type: "document" | "presentation"; requirementRef: string; body: string }> = {
        research: { file: "sources.md", logicalName: "source-record", type: "document", requirementRef: "R-SOURCE", body: "verified sources" },
        deck: { file: "deck.pptx", logicalName: "deck", type: "presentation", requirementRef: "R-DECK", body: "pptx bytes" },
        notes: { file: "notes.md", logicalName: "speaker-notes", type: "document", requirementRef: "R-NOTES", body: "speaker notes" }
      };
      const output = outputs[request.workItemId];
      if (!output) throw new Error(`Unexpected work ${request.workItemId}`);
      writeFileSync(join(request.workspaceRoot!, output.file), output.body, "utf8");
      return { text: JSON.stringify({ status: "completed", summary: request.workItemId, outputs: [{ path: output.file, logicalName: output.logicalName, type: output.type, requirementRefs: [output.requirementRef] }], proposedFacts: [], proposedWork: [], warnings: [] }) };
    }
  });

  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider, maxConcurrency: 4 });
  await runtime.controller.createMission(missionId, "produce a staged keynote package");
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  assert.deepEqual(executionOrder, ["research", "deck", "notes"], "downstream work must not dispatch before its final artifact dependency");
  assert.equal(planCalls, 2, "planner should expand a second frontier after partial final artifacts, then stop once acceptance is satisfied");
  assert.equal((await runtime.controller.state(missionId)).status, "completed");
  const artifacts = await runtime.projections.listArtifacts(missionId);
  assert.deepEqual(artifacts.filter(item => item.status === "final").map(item => item.logicalName).sort(), ["deck", "source-record", "speaker-notes"]);
  runtime.close();
});
