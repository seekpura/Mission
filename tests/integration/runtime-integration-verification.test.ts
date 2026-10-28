import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { ArtifactAssurancePipeline } from "../../src/runtime/orchestration/artifact-assurance-pipeline.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { RuntimeCommandCheckExecutor } from "../../src/core/verification/runtime-command-check-executor.ts";
import { IntegrationCheckExecutor } from "../../src/core/verification/integration-check-executor.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

function verifier() { return new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), new RuntimeCommandCheckExecutor(), new IntegrationCheckExecutor()])); }

async function setupRuntime(missionId: string, contract: AcceptanceContract) {
  const root = mkdtempSync(join(tmpdir(), "mission-runtime-verify-"));
  const runtime = new MissionRuntime({ rootDir: root, host: new FakeHostAdapter() });
  await runtime.controller.createMission(missionId, contract.requirements[0]?.description ?? "verify");
  await runtime.controller.emit(missionId, "acceptance.revised", { revision: contract.revision, contract }, { type: "user" }, `acceptance:${missionId}:${contract.revision}`);
  return { root, runtime };
}

test("runtime validation executes a structured command and satisfies a test-backed requirement", async () => {
  const missionId = "runtime-validation-pass";
  const requirement: Requirement = { id: "r-test", description: "Program executes successfully", type: "functional", priority: "required", verification: "test", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "program", type: "code", requirementRefs: [requirement.id] }], requiredValidations: [{ id: "run-program", description: "Run generated program", level: "functional", requirementRefs: [requirement.id], runtime: { command: process.execPath, args: ["{artifact}"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-runtime");
  writeFileSync(join(workspace.root, "program.mjs"), "process.exit(0);", "utf8");
  const work = { id: "work-program", missionId, purpose: "production" as const, objective: "build program", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "program", type: "code", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "program", outputs: [{ path: "program.mjs", logicalName: "program", type: "code" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-runtime", workspace.root, envelope);
  assert.equal(result.ok, true);
  assert.equal((await runtime.projections.listRequirements(missionId)).find(item => item.id === requirement.id)?.status, "satisfied");
  assert.ok((await runtime.projections.listVerificationResults(missionId)).some(item => item.checkResults.some(check => check.id === "validation-run-program" && check.status === "pass")));
  runtime.close();
});

test("failing runtime validation creates a blocking artifact gap and leaves requirement unverified", async () => {
  const missionId = "runtime-validation-fail";
  const requirement: Requirement = { id: "r-test", description: "Program executes successfully", type: "functional", priority: "required", verification: "test", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "program", type: "code", requirementRefs: [requirement.id] }], requiredValidations: [{ id: "run-program", description: "Run generated program", level: "functional", requirementRefs: [requirement.id], runtime: { command: process.execPath, args: ["{artifact}"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const workspace = runtime.workspaces.allocate(missionId, "attempt-runtime-fail");
  writeFileSync(join(workspace.root, "program.mjs"), "process.exit(3);", "utf8");
  const work = { id: "work-program", missionId, purpose: "production" as const, objective: "build program", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "program", type: "code", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "program", outputs: [{ path: "program.mjs", logicalName: "program", type: "code" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-runtime-fail", workspace.root, envelope);
  assert.equal(result.ok, false);
  assert.equal((await runtime.projections.listRequirements(missionId)).find(item => item.id === requirement.id)?.status, "unverified");
  assert.ok((await runtime.projections.listGaps(missionId)).some(gap => gap.category === "quality" && gap.status === "open"));
  runtime.close();
});

test("integration validation verifies specifically named artifacts and AcceptanceEvaluator requires the exact validation check", async () => {
  const missionId = "integration-validation";
  const requirement: Requirement = { id: "r-bundle", description: "Bundle artifact exists", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId, revision: 2, requirements: [requirement], requiredArtifacts: [{ logicalName: "bundle", type: "document", requirementRefs: [requirement.id] }, { logicalName: "manifest", type: "document", requirementRefs: [] }], requiredValidations: [{ id: "bundle-pair", description: "Bundle and manifest are both present", level: "integration", requirementRefs: [], integration: { mode: "artifacts-present", artifactLogicalNames: ["bundle", "manifest"] } }], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const { runtime } = await setupRuntime(missionId, contract);
  const manifestWorkspace = runtime.workspaces.allocate(missionId, "attempt-manifest");
  writeFileSync(join(manifestWorkspace.root, "manifest.md"), "manifest", "utf8");
  const manifestArtifact = runtime.artifacts.commit({ missionId, logicalName: "manifest", type: "document", sourcePath: join(manifestWorkspace.root, "manifest.md"), producedByAttemptId: "attempt-manifest" });
  await runtime.controller.recordArtifact(missionId, manifestArtifact);
  await runtime.controller.validateArtifact(missionId, `${manifestArtifact.id}@${manifestArtifact.version}`, true);

  const workspace = runtime.workspaces.allocate(missionId, "attempt-bundle"); writeFileSync(join(workspace.root, "bundle.md"), "bundle", "utf8");
  const work = { id: "work-bundle", missionId, purpose: "integration" as const, objective: "integrate bundle", status: "ready" as const, requirementRefs: [requirement.id], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "bundle", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner" as const, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const envelope = { status: "completed" as const, summary: "bundle", outputs: [{ path: "bundle.md", logicalName: "bundle", type: "document" as const, requirementRefs: [requirement.id] }], proposedFacts: [], proposedWork: [], warnings: [] };
  const pipeline = new ArtifactAssurancePipeline({ controller: runtime.controller, projections: runtime.projections, artifacts: runtime.artifacts, verifier: verifier() });
  const result = await pipeline.process(work, "attempt-bundle", workspace.root, envelope);
  assert.equal(result.ok, true);
  const evaluation = await runtime.controller.acceptanceEvaluation(missionId);
  assert.equal(evaluation.missingValidations.includes("bundle-pair"), false);
  runtime.close();
});
