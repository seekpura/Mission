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

function createRendererSkillRepo(root: string) {
  const repo = join(root, "renderer-skill"); mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "SKILL.md"), "# Presentation Page Renderer\nRender presentation pages to images for inspection output.\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "SKILL.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deck"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: {
          missionId,
          revision: 1,
          requirements: [{ id: "R-VISUAL", description: "Deck has clear visual hierarchy", type: "visual", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] }],
          requiredArtifacts: [{ logicalName: "deck", type: "presentation", requirementRefs: ["R-VISUAL"] }],
          requiredValidations: [],
          criticalFailureConditions: [],
          createdAt: now
        }
      };
    },
    async composeStrategy() { return { framing: "produce then independently inspect", approach: "acquire QA capability only when verification proves it is missing", workstreams: [{ id: "deck", objective: "deliver verified deck" }], revision: 1 }; },
    async planFrontier({ state }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        capabilityNeeds: [],
        workItems: [{
          id: "produce-deck",
          missionId: state.missionId,
          workstreamId: "deck",
          purpose: "production",
          objective: "Create the requested deck",
          status: "ready",
          requirementRefs: ["R-VISUAL"],
          gapRefs: [],
          inputArtifactRefs: [],
          expectedOutputs: [{ logicalName: "deck", type: "presentation", required: true }],
          localAcceptanceCriteria: [],
          capabilityNeedRefs: [],
          priority: 90,
          graphRevision: state.graphRevision + 1,
          createdBy: "planner",
          createdAt: now,
          updatedAt: now
        }]
      };
    },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("missing render capability is acquired and verification resumes without regenerating the production artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-capability-"));
  const repo = createRendererSkillRepo(root);
  let productionCalls = 0;
  let inspectionCalls = 0;
  let reviewCalls = 0;
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      const context = request.context as any;
      if (context?.kind === "inspection-production") {
        inspectionCalls += 1;
        assert.ok(context.capability?.invocationRef, "acquired mission-local capability must be supplied to the inspection agent");
        const path = join(request.workspaceRoot!, "slide-1.png");
        writeFileSync(path, "rendered-slide", "utf8");
        return {
          providerId: "fixture-renderer",
          sourceArtifactRef: `${context.sourceArtifact.id}@${context.sourceArtifact.version}`,
          products: [{ kind: "page-render", path, type: "image", logicalSuffix: "slide-1", mimeType: "image/png" }]
        };
      }
      if (context?.kind === "verification-review") {
        reviewCalls += 1;
        assert.equal(context.inspectionArtifacts.length, 1);
        return { status: "pass", detail: "Rendered slide has clear hierarchy", confidence: 0.95 };
      }
      productionCalls += 1;
      assert.ok(request.workspaceRoot);
      writeFileSync(join(request.workspaceRoot!, "deck.pptx"), "original-deck-bytes", "utf8");
      return {
        text: JSON.stringify({
          status: "completed",
          summary: "deck produced once",
          outputs: [{ path: "deck.pptx", logicalName: "deck", type: "presentation", requirementRefs: ["R-VISUAL"] }],
          proposedFacts: [], proposedWork: [], warnings: []
        })
      };
    }
  });

  const acquisition = new SecureAcquisitionService({
    providers: [{ id: "fixture", async discover() { return [{ id: "candidate-renderer", sourceType: "github", sourceUri: repo, name: "fixture/presentation-page-renderer", description: "render presentation pages to images inspection output", candidateKind: "skill", status: "discovered" }]; } }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))),
    overlay: new MissionCapabilityOverlay(),
    activationRoot: join(root, "capabilities")
  });

  const runtime = new MissionRuntime({ rootDir: join(root, "runtime"), host, deliberation: provider(), acquisition });
  await runtime.controller.createMission("m-self-heal-qa", "create a visually strong deck");
  await runtime.orchestrator!.runUntilQuiescent("m-self-heal-qa");

  const state = await runtime.controller.state("m-self-heal-qa");
  assert.equal(state.status, "completed");
  assert.equal(productionCalls, 1, "production must not rerun merely because QA tooling was initially missing");
  assert.equal(inspectionCalls, 1);
  assert.equal(reviewCalls, 1);

  const artifacts = await runtime.projections.listArtifacts("m-self-heal-qa");
  const deckVersions = artifacts.filter(item => item.logicalName === "deck");
  assert.equal(deckVersions.length, 1);
  assert.equal(deckVersions[0]?.version, 1);
  assert.equal(deckVersions[0]?.status, "final");
  assert.ok(artifacts.some(item => item.logicalName.startsWith("__inspection__") && item.sourceArtifactRefs.includes("deck@1")));

  const needs = await runtime.projections.listCapabilityNeeds("m-self-heal-qa");
  const renderNeed = needs.find(item => item.id === "verification-inspection-presentation-page-render");
  assert.equal(renderNeed?.purpose, "verification");
  assert.equal(renderNeed?.status, "available");
  assert.ok(renderNeed?.resolvedCapabilityRef);

  const workItems = await runtime.projections.listWorkItems("m-self-heal-qa");
  assert.equal(workItems.find(item => item.id === "produce-deck")?.status, "succeeded");
  assert.equal(workItems.find(item => item.id === "verify-deck-v1")?.status, "succeeded");
  assert.equal(workItems.find(item => item.id === "acquire-verification-inspection-presentation-page-render")?.status, "succeeded");

  const events = await runtime.events.list("m-self-heal-qa");
  assert.ok(events.some(event => event.type === "capability.need.created" && (event.payload as any).need?.purpose === "verification"));
  assert.ok(events.some(event => event.type === "capability.activated"));
  assert.ok(events.some(event => event.type === "execution.created" && (event.payload as any).executorType === "assurance-runtime"));
  runtime.close();
});
