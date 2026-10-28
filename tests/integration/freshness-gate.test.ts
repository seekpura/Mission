import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["report"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "fresh benchmark", type: "evidence", priority: "critical", verification: "evidence", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "report", type: "document", requirementRefs: ["R1"] }],
          requiredValidations: [], criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "freshness", approach: "keep evidence current", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: "source expired", intervention: "revise_work", confidence: 0.9 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("orchestrator scans freshness before control cycle and reopens a completed mission whose evidence expired", async () => {
  const root = mkdtempSync(join(tmpdir(), "freshness-gate-"));
  const runtime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter(), deliberation: provider() });
  const missionId = "m-freshness";
  const now = new Date().toISOString();
  await runtime.controller.createMission(missionId, "deliver fresh benchmark report");
  await runtime.knowledge.registerSource({
    id: "s1", missionId, type: "web", uri: "https://example.test/benchmark",
    capturedAt: now, freshUntil: new Date(Date.now() - 1000).toISOString(), status: "active", metadata: {}
  });
  await runtime.knowledge.recordTruth({
    id: "t1", missionId, key: "benchmark.score", value: 88, source: "source", sourceRefs: ["s1"],
    confidence: "verified", status: "active", requirementRefs: ["R1"], artifactRefs: ["report@1"], createdAt: now
  });
  await runtime.controller.recordArtifact(missionId, {
    id: "report", missionId, logicalName: "report", type: "document", version: 1, status: "verified",
    uri: "/tmp/report.txt", contentHash: "h1", producedByAttemptId: "a1", sourceArtifactRefs: [], createdAt: now
  });
  await runtime.controller.validateArtifact(missionId, "report@1", true);
  await runtime.controller.recordEvidence(missionId, {
    id: "ev1", missionId, subjectRef: "R1", type: "source", claim: "fresh benchmark evidence", result: "supports", sourceRef: "t1", validity: "active", createdAt: now
  });
  await runtime.controller.setRequirementStatus(missionId, "R1", "satisfied", ["ev1"]);
  await runtime.controller.emit(missionId, "mission.completed", { reason: "fixture complete" }, { type: "controller" });
  assert.equal((await runtime.controller.state(missionId)).status, "completed");

  await runtime.orchestrator!.runUntilQuiescent(missionId);

  assert.equal((await runtime.projections.listSources(missionId)).find(source => source.id === "s1")?.status, "stale");
  assert.equal((await runtime.projections.listTruths(missionId)).find(truth => truth.id === "t1")?.status, "stale");
  assert.equal((await runtime.projections.listEvidence(missionId)).find(evidence => evidence.id === "ev1")?.validity, "invalid");
  assert.equal((await runtime.projections.listRequirements(missionId)).find(requirement => requirement.id === "R1")?.status, "unverified");
  assert.equal((await runtime.projections.listArtifacts(missionId)).find(artifact => artifact.id === "report")?.status, "invalid");
  assert.equal((await runtime.projections.listGaps(missionId)).some(gap => gap.id === "stale-source:s1" && gap.status === "open"), true);
  assert.notEqual((await runtime.controller.state(missionId)).status, "completed");
  runtime.close();
});
