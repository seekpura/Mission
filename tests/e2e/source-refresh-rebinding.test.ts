import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { KnowledgeContextSelector } from "../../src/core/context/knowledge-context-selector.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["report"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "deliver report using refreshed benchmark", type: "evidence", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "report", type: "document", requirementRefs: ["R1"] }],
          requiredValidations: [{ id: "structural", description: "report exists", level: "structural", requirementRefs: ["R1"] }],
          criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "refresh", approach: "replace stale evidence and verify output", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: "benchmark source is stale", intervention: "revise_work", confidence: 0.95 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("stale source repair explicitly supersedes old source/truth and completes only after refreshed artifact verification", async () => {
  const root = mkdtempSync(join(tmpdir(), "source-refresh-"));
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      const context = request.context as any;
      assert.deepEqual(context.contextPacket.truthRefs, []);
      assert.deepEqual(context.invalidatedKnowledge.sources.map((source: any) => source.id), ["source-old"]);
      assert.deepEqual(context.invalidatedKnowledge.truths.map((truth: any) => truth.id), ["truth-old"]);
      writeFileSync(join(request.workspaceRoot!, "report.txt"), "fresh benchmark score: 42\n", "utf8");
      return { text: JSON.stringify({
        status: "completed",
        summary: "refreshed benchmark source and report",
        outputs: [{ path: "report.txt", logicalName: "report", type: "document", requirementRefs: ["R1"] }],
        sources: [{
          id: "source-new", type: "web", uri: "https://example.test/benchmark/current",
          capturedAt: new Date().toISOString(), freshUntil: new Date(Date.now() + 86400000).toISOString(),
          authority: "official", replacesSourceRef: "source-old"
        }],
        proposedFacts: [{
          key: "benchmark.score", value: 42, sourceRefs: ["source-new"], requirementRefs: ["R1"], supersedesTruthRef: "truth-old"
        }],
        proposedWork: [], warnings: []
      }) };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider() });
  const missionId = "m-refresh";
  await runtime.controller.createMission(missionId, "refresh stale benchmark and deliver report");
  const now = new Date().toISOString();
  await runtime.knowledge.registerSource({
    id: "source-old", missionId, type: "web", uri: "https://example.test/benchmark/old",
    capturedAt: now, status: "stale", metadata: {}
  });
  await runtime.knowledge.recordTruth({
    id: "truth-old", missionId, key: "benchmark.score", value: 17, source: "source",
    sourceRefs: ["source-old"], confidence: "verified", status: "stale",
    requirementRefs: ["R1"], artifactRefs: [], createdAt: now
  });
  await runtime.controller.openGap(missionId, {
    id: "stale-source:source-old", severity: "major", category: "fact",
    description: "old benchmark source is stale", requirementRefs: ["R1"], artifactRefs: [], sourceRefs: ["source-old"]
  });
  const repair: WorkItem = {
    id: "repair-stale-source", missionId, purpose: "repair", objective: "refresh source-old and update report",
    status: "ready", requirementRefs: ["R1"], gapRefs: ["stale-source:source-old"], inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "report", type: "document", required: true }],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 100, graphRevision: 1,
    createdBy: "replanner", createdAt: now, updatedAt: now
  };
  await runtime.controller.proposeWork(repair);
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  const sources = await runtime.projections.listSources(missionId);
  const oldSource = sources.find(source => source.id === "source-old");
  const newSource = sources.find(source => source.id === "source-new");
  assert.equal(oldSource?.status, "superseded");
  assert.equal(oldSource?.supersededBy, "source-new");
  assert.equal(newSource?.status, "active");

  const truths = await runtime.projections.listTruths(missionId);
  const oldTruth = truths.find(truth => truth.id === "truth-old");
  const newTruth = truths.find(truth => truth.key === "benchmark.score" && truth.id !== "truth-old");
  assert.equal(oldTruth?.status, "superseded");
  assert.equal(oldTruth?.supersededBy, newTruth?.id);
  assert.equal(newTruth?.status, "active");
  assert.equal(newTruth?.confidence, "verified");
  assert.deepEqual(newTruth?.sourceRefs, ["source-new"]);

  const requirements = await runtime.projections.listRequirements(missionId);
  assert.equal(requirements.find(requirement => requirement.id === "R1")?.status, "satisfied");
  const gaps = await runtime.projections.listGaps(missionId);
  assert.equal(gaps.find(gap => gap.id === "stale-source:source-old")?.status, "resolved");
  const artifacts = await runtime.projections.listArtifacts(missionId);
  assert.equal(artifacts.find(artifact => artifact.logicalName === "report")?.status, "final");
  assert.equal((await runtime.controller.state(missionId)).status, "completed");

  const selector = new KnowledgeContextSelector();
  const selection = selector.select({
    workItem: { ...repair, id: "downstream", purpose: "production", gapRefs: [], status: "ready" },
    truths, sources, gaps
  });
  assert.deepEqual(selection.truths.map(truth => truth.id), [newTruth?.id]);
  assert.deepEqual(selection.sources.map(source => source.id), ["source-new"]);
  runtime.close();
});
