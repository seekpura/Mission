import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { SecureAcquisitionService } from "../../src/core/capabilities/secure-acquisition-service.ts";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";
import { CapabilitySmokeTester } from "../../src/core/capabilities/sandbox/smoke-tester.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";

function createSkillRepo(root: string) {
  const repo = join(root, "skill-source"); mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "SKILL.md"), "# Special Rendering\nProvides special rendering capability.\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "SKILL.md"]); execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deliverable"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: { missionId, revision: 1, requirements: [{ id: "R1", description: "deliverable exists", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }], requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }], requiredValidations: [{ id: "structural", description: "structural", level: "structural", requirementRefs: ["R1"] }], criticalFailureConditions: [], createdAt: now }
      };
    },
    async composeStrategy() { return { framing: "need-driven", approach: "acquire only when required", workstreams: [{ id: "delivery", objective: "deliver" }], revision: 1 }; },
    async planFrontier({ state }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        capabilityNeeds: [{ id: "need-special", missionId: state.missionId, objective: "special rendering", requiredFunctions: ["special rendering"], desiredInputs: [], desiredOutputs: [], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: ["R1"], gapRefs: [], status: "checking-installed" }],
        workItems: [{ id: "produce", missionId: state.missionId, workstreamId: "delivery", purpose: "production", objective: "produce requested document with special rendering capability", status: "ready", requirementRefs: ["R1"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: ["need-special"], priority: 90, graphRevision: state.graphRevision + 1, createdBy: "planner", createdAt: now, updatedAt: now }]
      };
    },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("missing capability becomes acquisition work, activates mission-locally, unblocks original work and completes acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-e2e-"));
  const repo = createSkillRepo(root);
  let workerCapabilityRefs: string[] = [];
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      workerCapabilityRefs = request.allowedCapabilityRefs;
      const capabilities = (request.context as any).capabilities ?? [];
      assert.equal(capabilities.length, 1);
      writeFileSync(join(request.workspaceRoot!, "deliverable.txt"), "rendered with acquired capability\n", "utf8");
      return { text: JSON.stringify({ status: "completed", summary: "done", outputs: [{ path: "deliverable.txt", logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }], proposedFacts: [], proposedWork: [], warnings: [] }) };
    }
  });
  const overlay = new MissionCapabilityOverlay();
  const acquisition = new SecureAcquisitionService({
    providers: [{ id: "fixture", async discover() { return [{ id: "candidate-special", sourceType: "github", sourceUri: repo, name: "fixture/special-render", description: "special rendering skill", candidateKind: "skill", status: "discovered" }]; } }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))), overlay,
    activationRoot: join(root, "capabilities")
  });
  const runtime = new MissionRuntime({ rootDir: join(root, "runtime"), host, deliberation: provider(), acquisition });
  await runtime.controller.createMission("m-cap", "produce a deliverable requiring a missing capability");
  await runtime.orchestrator!.runUntilQuiescent("m-cap");

  const state = await runtime.controller.state("m-cap");
  assert.equal(state.status, "completed");
  assert.equal(workerCapabilityRefs.length, 1);
  const needs = await runtime.projections.listCapabilityNeeds("m-cap");
  assert.equal(needs[0]?.status, "available");
  assert.equal(needs[0]?.resolvedCapabilityRef, workerCapabilityRefs[0]);
  const capabilities = await runtime.projections.listCapabilities("m-cap");
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0]?.scope, "mission");
  const receipts = await runtime.projections.listAcquisitionReceipts("m-cap");
  assert.equal(receipts[0]?.status, "activated");
  const events = await runtime.events.list("m-cap");
  assert.ok(events.some(e => e.type === "capability.candidate.materialized"));
  assert.ok(events.some(e => e.type === "capability.candidate.scanned"));
  assert.ok(events.some(e => e.type === "capability.candidate.sandboxed"));
  assert.ok(events.some(e => e.type === "capability.activated"));
  assert.ok(events.some(e => e.type === "work.blocked" && (e.payload as any).id === "produce"));
  assert.ok(events.some(e => e.type === "work.updated" && (e.payload as any).id === "produce" && (e.payload as any).status === "ready"));
  runtime.close();
});
