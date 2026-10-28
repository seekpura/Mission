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
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["repair-report"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "refresh stale benchmark evidence", type: "evidence", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "repair-report", type: "document", requirementRefs: ["R1"] }], requiredValidations: [], criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "repair", approach: "refresh stale evidence", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: "source is stale", intervention: "revise_work", confidence: 0.9 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("repair worker sees stale source as diagnostic knowledge but never as active truth", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-repair-context-"));
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      const context = request.context as any;
      assert.deepEqual(context.contextPacket.truthRefs, []);
      assert.deepEqual(context.contextPacket.sourceRefs, []);
      assert.deepEqual(context.truths, []);
      assert.deepEqual(context.sources, []);
      assert.deepEqual(context.gaps.map((gap: any) => gap.id), ["g-stale"]);
      assert.deepEqual(context.gaps[0].sourceRefs, ["s-old"]);
      assert.deepEqual(context.invalidatedKnowledge.sources.map((source: any) => source.id), ["s-old"]);
      assert.deepEqual(context.invalidatedKnowledge.truths.map((truth: any) => truth.id), ["t-old"]);
      writeFileSync(join(request.workspaceRoot!, "repair.txt"), "refreshed source required\n", "utf8");
      return { text: JSON.stringify({
        status: "completed", summary: "prepared refresh repair",
        outputs: [{ path: "repair.txt", logicalName: "repair-report", type: "document", requirementRefs: ["R1"] }],
        proposedFacts: [], proposedWork: [], warnings: []
      }) };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider() });
  const missionId = "m-source-repair";
  await runtime.controller.createMission(missionId, "refresh stale benchmark evidence");
  const now = new Date().toISOString();
  await runtime.knowledge.registerSource({ id: "s-old", missionId, type: "web", uri: "https://example.test/old", capturedAt: now, status: "stale", metadata: {} });
  await runtime.knowledge.recordTruth({ id: "t-old", missionId, key: "benchmark", value: 17, source: "source", sourceRefs: ["s-old"], confidence: "verified", status: "stale", requirementRefs: ["R1"], artifactRefs: [], createdAt: now });
  await runtime.controller.openGap(missionId, { id: "g-stale", severity: "major", category: "fact", description: "benchmark source is stale", requirementRefs: ["R1"], artifactRefs: [], sourceRefs: ["s-old"] });
  const work: WorkItem = {
    id: "repair-g-stale", missionId, purpose: "repair", objective: "refresh stale benchmark source", status: "ready",
    requirementRefs: ["R1"], gapRefs: ["g-stale"], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "repair-report", type: "document", required: true }],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1, createdBy: "replanner", createdAt: now, updatedAt: now
  };
  await runtime.controller.proposeWork(work);
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  assert.ok(host.agentRequests.length >= 1);
  runtime.close();
});
