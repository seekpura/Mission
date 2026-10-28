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
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deliverable"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "use the current verified fact", type: "content", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
          requiredValidations: [], criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "knowledge", approach: "use relevant truth only", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 0.8 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("worker execution receives only active knowledge relevant to its requirements", async () => {
  const root = mkdtempSync(join(tmpdir(), "knowledge-context-"));
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      const context = request.context as any;
      assert.deepEqual(context.contextPacket.truthRefs, ["t-active"]);
      assert.deepEqual(context.contextPacket.sourceRefs, ["s-active"]);
      assert.deepEqual(context.truths.map((truth: any) => truth.id), ["t-active"]);
      assert.deepEqual(context.sources.map((source: any) => source.id), ["s-active"]);
      assert.equal(context.truths[0].value, 42);
      writeFileSync(join(request.workspaceRoot!, "deliverable.txt"), "uses current fact 42\n", "utf8");
      return { text: JSON.stringify({
        status: "completed", summary: "used current fact",
        outputs: [{ path: "deliverable.txt", logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
        proposedFacts: [], proposedWork: [], warnings: []
      }) };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider() });
  const missionId = "m-context";
  await runtime.controller.createMission(missionId, "produce a fact-based document");
  const now = new Date().toISOString();
  await runtime.knowledge.registerSource({ id: "s-active", missionId, type: "web", uri: "https://example.test/current", capturedAt: now, status: "active", metadata: {} });
  await runtime.knowledge.registerSource({ id: "s-old", missionId, type: "web", uri: "https://example.test/old", capturedAt: now, status: "stale", metadata: {} });
  await runtime.knowledge.recordTruth({ id: "t-active", missionId, key: "metric", value: 42, source: "source", sourceRefs: ["s-active"], confidence: "verified", status: "active", requirementRefs: ["R1"], artifactRefs: [], createdAt: now });
  await runtime.knowledge.recordTruth({ id: "t-stale", missionId, key: "metric.old", value: 17, source: "source", sourceRefs: ["s-old"], confidence: "verified", status: "stale", requirementRefs: ["R1"], artifactRefs: [], createdAt: now });
  const work: WorkItem = {
    id: "w-context", missionId, purpose: "production", objective: "create deliverable using R1 knowledge", status: "ready",
    requirementRefs: ["R1"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now
  };
  await runtime.controller.proposeWork(work);
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  assert.equal(host.agentRequests.length >= 1, true);
  runtime.close();
});
