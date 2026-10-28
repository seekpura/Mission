import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { ArtifactAssurancePipeline } from "../../src/runtime/orchestration/artifact-assurance-pipeline.ts";
import { ArtifactInspectionService } from "../../src/runtime/orchestration/artifact-inspection-service.ts";
import { InspectionProviderRegistry } from "../../src/core/inspection/inspection-registry.ts";
import type { InspectionProvider } from "../../src/core/inspection/inspection-provider.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { HostReviewCheckExecutor } from "../../src/core/verification/host-review-check-executor.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

class FakePresentationInspectionProvider implements InspectionProvider {
  id = "fake-presentation-renderer";
  version = "1";
  supports(artifact: any, request: any): boolean { return artifact.type === "presentation" && request.kind === "page-render"; }
  async inspect(artifact: any, _request: any, context: any) {
    const path = join(context.outputDir, "slide-1.png");
    writeFileSync(path, "rendered-slide-pixels", "utf8");
    return {
      providerId: this.id,
      providerVersion: this.version,
      sourceArtifactRef: `${artifact.id}@${artifact.version}`,
      products: [{ kind: "page-render" as const, path, type: "image" as const, logicalSuffix: "slide-1", mimeType: "image/png" }]
    };
  }
}

function acceptance(missionId: string) {
  const requirement: Requirement = { id: "r-visual", description: "Deck has strong visual hierarchy", type: "visual", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "deck", type: "presentation", requirementRefs: [requirement.id] }], requiredValidations: [], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  return { requirement, contract };
}

async function prepare(root: string, host: FakeHostAdapter, missionId: string) {
  const runtime = new MissionRuntime({ rootDir: root, host });
  await runtime.controller.createMission(missionId, "make visual deck");
  const { requirement, contract } = acceptance(missionId);
  await runtime.controller.emit(missionId, "acceptance.revised", { revision: 2, contract }, { type: "user" }, `acceptance:${missionId}:2`);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-v"); writeFileSync(join(workspace.root, "deck.pptx"), "ppt-data", "utf8");
  const work = { id: "work-deck", missionId, purpose: "production" as const, objective: "make deck", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deck", type: "presentation", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "deck", outputs: [{ path: "deck.pptx", logicalName: "deck", type: "presentation" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  return { runtime, requirement, workspace, work, envelope };
}

test("artifact assurance refuses to promote visual requirements when perceptual verifier is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-no-review-")); const host = new FakeHostAdapter();
  const { runtime, requirement, workspace, work, envelope } = await prepare(root, host, "m-no-review");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor()]));
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier });
  const result = await pipeline.process(work, "attempt-v", workspace.root, envelope);
  assert.equal(result.ok, false);
  assert.equal((await runtime.projections.listRequirements("m-no-review")).find(item => item.id === requirement.id)?.status, "unverified");
  assert.ok((await runtime.projections.listGaps("m-no-review")).some(gap => gap.category === "quality"));
  runtime.close();
});

test("presentation reviewer cannot pass perceptual verification without derived renders", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-review-no-render-"));
  const host = new FakeHostAdapter([], { agentResponder: () => ({ status: "pass", detail: "I would pass anything", confidence: 1 }) });
  const { runtime, requirement, workspace, work, envelope } = await prepare(root, host, "m-review-no-render");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), new HostReviewCheckExecutor(host)]));
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier });
  const result = await pipeline.process(work, "attempt-v", workspace.root, envelope);
  assert.equal(result.ok, false);
  assert.equal((await runtime.projections.listRequirements("m-review-no-render")).find(item => item.id === requirement.id)?.status, "unverified");
  assert.equal(host.agentRequests.length, 0, "reviewer must not be asked to infer presentation appearance from a PPTX path");
  runtime.close();
});

test("independent host reviewer can satisfy visual requirement only after a derived slide render exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-review-pass-"));
  const host = new FakeHostAdapter([], { agentResponder: request => {
    const context = request.context as any;
    if (context?.kind === "verification-review") {
      assert.equal(context.inspectionArtifacts.length, 1);
      assert.equal(context.inspectionArtifacts[0].type, "image");
      assert.ok(context.inspectionArtifacts[0].sourceArtifactRefs.includes("deck@1"));
      return { status: "pass", detail: "Rendered slide hierarchy is clear at presentation scale", confidence: 0.9 };
    }
    return {};
  }});
  const { runtime, requirement, workspace, work, envelope } = await prepare(root, host, "m-review-pass");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), new HostReviewCheckExecutor(host)]));
  const inspectionService = new ArtifactInspectionService({
    controller: runtime.controller,
    artifacts: runtime.artifacts,
    workspaces: runtime.workspaces,
    registry: new InspectionProviderRegistry([new FakePresentationInspectionProvider()])
  });
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier, inspectionService });
  const result = await pipeline.process(work, "attempt-v", workspace.root, envelope);
  assert.equal(result.ok, true);
  const projected = (await runtime.projections.listRequirements("m-review-pass")).find(item => item.id === requirement.id);
  assert.equal(projected?.status, "satisfied");
  assert.ok((projected?.evidenceRefs.length ?? 0) > 0);
  const artifacts = await runtime.projections.listArtifacts("m-review-pass");
  const inspectionArtifact = artifacts.find(item => item.logicalName.startsWith("__inspection__"));
  assert.ok(inspectionArtifact);
  assert.deepEqual(inspectionArtifact?.sourceArtifactRefs, ["deck@1"]);
  const state = await runtime.controller.state("m-review-pass");
  assert.deepEqual(state.finalArtifactRefs, ["deck@1"]);
  runtime.close();
});
