import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deliverable"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId, revision: 1,
          requirements: [{ id: "R1", description: "produce the requested document", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "deliverable", type: "document", description: "final requested document", requirementRefs: ["R1"] }],
          requiredValidations: [{ id: "structural", description: "file structural validation", level: "structural", requirementRefs: ["R1"] }],
          criticalFailureConditions: [], createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "single deliverable", approach: "produce then independently verify", workstreams: [{ id: "delivery", objective: "produce output" }], revision: 1 }; },
    async planFrontier({ state, requirements }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        workItems: [{
          id: "produce-deliverable", missionId: state.missionId, workstreamId: "delivery", purpose: "production", objective: "Create the final requested document in the assigned workspace",
          status: "ready", requirementRefs: requirements?.map(r => r.id) ?? ["R1"], gapRefs: [], inputArtifactRefs: [],
          expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }],
          localAcceptanceCriteria: [{ id: "local-file", description: "document exists", priority: "required" }], capabilityNeedRefs: [], priority: 90,
          graphRevision: state.graphRevision + 1, createdBy: "planner", createdAt: now, updatedAt: now
        }]
      };
    },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("mission autonomously consumes the frontier, commits output, verifies evidence, satisfies acceptance and completes", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-orchestrator-"));
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      assert.ok(request.workspaceRoot);
      writeFileSync(join(request.workspaceRoot!, "deliverable.txt"), "verified mission output\n", "utf8");
      return {
        text: JSON.stringify({
          status: "completed",
          summary: "produced requested document",
          outputs: [{ path: "deliverable.txt", logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
          proposedFacts: [], proposedWork: [], warnings: []
        })
      };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host, deliberation: provider(), maxConcurrency: 2 });
  await runtime.controller.createMission("m-auto", "produce one verified document");
  assert.ok(runtime.orchestrator);
  await runtime.orchestrator!.runUntilQuiescent("m-auto");

  const state = await runtime.controller.state("m-auto");
  assert.equal(state.status, "completed");
  assert.equal(state.blockingGapIds.length, 0);
  assert.equal(state.finalArtifactRefs.length, 1);

  const requirements = await runtime.projections.listRequirements("m-auto");
  assert.equal(requirements[0]?.status, "satisfied");

  const artifacts = await runtime.projections.listArtifacts("m-auto");
  assert.equal(artifacts[0]?.status, "final");

  const verifications = await runtime.projections.listVerificationResults("m-auto");
  assert.equal(verifications[0]?.overall, "pass");
  const requirementChecks = verifications[0]?.checkResults.filter(check => check.status === "pass" && check.requirementRefs?.includes("R1")) ?? [];
  assert.ok(requirementChecks.length >= 2, "artifact requirement should have concrete passing verification checks");

  const evidence = await runtime.projections.listEvidence("m-auto");
  const requirementEvidenceRefs = requirements[0]?.evidenceRefs ?? [];
  assert.equal(requirementEvidenceRefs.length, requirementChecks.length);
  for (const evidenceRef of requirementEvidenceRefs) {
    const item = evidence.find(candidate => candidate.id === evidenceRef);
    assert.ok(item, `missing requirement evidence ${evidenceRef}`);
    assert.equal(item.subjectRef, "deliverable@1");
    assert.equal(item.result, "supports");
    assert.equal(item.validity ?? "active", "active");
  }

  const events = await runtime.events.list("m-auto");
  for (const type of ["attempt.created", "execution.started", "artifact.created", "verification.completed", "evidence.created", "requirement.status.changed", "mission.completed"]) {
    assert.ok(events.some(event => event.type === type), `missing event ${type}`);
  }
  runtime.close();
});
