import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";
import type { VerificationCheck, VerificationCheckResult } from "../../src/core/domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "../../src/core/verification/check-executor.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";

class CountingExecutor implements VerificationCheckExecutor {
  id: string;
  cacheVersion = "1";
  calls = 0;
  private readonly method: VerificationCheck["method"];
  constructor(id: string, method: VerificationCheck["method"]) { this.id = id; this.method = method; }
  supports(check: VerificationCheck): boolean { return check.method === this.method; }
  async execute(_artifact: Artifact, check: VerificationCheck, _context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    this.calls += 1;
    return { id: check.id, status: "pass", detail: `${this.id} pass`, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
  }
}

function artifact(path: string, hash = "artifact-hash", version = 1, logicalName = "deliverable"): Artifact {
  return {
    id: logicalName,
    missionId: "m-cache",
    logicalName,
    type: "document",
    version,
    status: "candidate",
    uri: path,
    contentHash: hash,
    producedByAttemptId: `attempt-${version}`,
    sourceArtifactRefs: [],
    createdAt: new Date().toISOString()
  };
}

function requirement(description = "content is correct"): Requirement {
  return { id: "R1", description, type: "content", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] };
}

function contract(req: Requirement): AcceptanceContract {
  return {
    missionId: "m-cache",
    revision: 1,
    requirements: [req],
    requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
    requiredValidations: [],
    criticalFailureConditions: [],
    createdAt: new Date().toISOString()
  };
}

test("unchanged artifact reuses cacheable checks while a changed requirement only reruns its semantic check", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-cache-"));
  const file = join(root, "deliverable.txt");
  writeFileSync(file, "same artifact bytes\n", "utf8");
  const semantic = new CountingExecutor("semantic-review", "semantic");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), semantic]));
  const current = artifact(file);
  const firstReq = requirement();
  const first = await verifier.verify(current, { acceptanceContract: contract(firstReq), requirements: [firstReq], explicitRequirementRefs: ["R1"], artifacts: [current] });
  assert.equal(first.overall, "pass");
  assert.equal(semantic.calls, 1);
  assert.equal(first.reusedCheckCount, 0);

  const second = await verifier.verify(current, { acceptanceContract: contract(firstReq), requirements: [firstReq], explicitRequirementRefs: ["R1"], artifacts: [current], priorVerifications: [first] });
  assert.equal(second.overall, "pass");
  assert.equal(semantic.calls, 1);
  assert.equal(second.reusedCheckCount, 3);

  const revisedReq = requirement("content matches the revised acceptance wording");
  const third = await verifier.verify(current, { acceptanceContract: { ...contract(revisedReq), revision: 2 }, requirements: [revisedReq], explicitRequirementRefs: ["R1"], artifacts: [current], priorVerifications: [first, second] });
  assert.equal(third.overall, "pass");
  assert.equal(semantic.calls, 2);
  assert.equal(third.reusedCheckCount, 2);
});

test("integration dependency content changes invalidate only the integration check", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-integration-cache-"));
  const file = join(root, "deliverable.txt");
  const depFile = join(root, "dependency.txt");
  writeFileSync(file, "deliverable\n", "utf8");
  writeFileSync(depFile, "dependency\n", "utf8");
  const integration = new CountingExecutor("integration-review", "integration");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), integration]));
  const current = artifact(file);
  const depV1 = artifact(depFile, "dep-hash-1", 1, "dependency");
  const integrationContract: AcceptanceContract = {
    missionId: "m-cache",
    revision: 1,
    requirements: [],
    requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: [] }],
    requiredValidations: [{ id: "bundle", description: "required artifacts integrate", level: "integration", requirementRefs: [], integration: { mode: "artifacts-present", artifactLogicalNames: ["dependency"] } }],
    criticalFailureConditions: [],
    createdAt: new Date().toISOString()
  };

  const first = await verifier.verify(current, { acceptanceContract: integrationContract, artifacts: [current, depV1] });
  assert.equal(integration.calls, 1);
  const second = await verifier.verify(current, { acceptanceContract: integrationContract, artifacts: [current, depV1], priorVerifications: [first] });
  assert.equal(integration.calls, 1);
  assert.equal(second.reusedCheckCount, 3);

  const depV2 = artifact(depFile, "dep-hash-2", 2, "dependency");
  const third = await verifier.verify(current, { acceptanceContract: integrationContract, artifacts: [current, depV2], priorVerifications: [first, second] });
  assert.equal(integration.calls, 2);
  assert.equal(third.reusedCheckCount, 2);
});

test("runtime checks are never reused from cache", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-runtime-cache-"));
  const file = join(root, "deliverable.txt");
  writeFileSync(file, "runtime target\n", "utf8");
  const runtime = new CountingExecutor("runtime-check", "runtime");
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor(), runtime]));
  const current = artifact(file);
  const runtimeReq: Requirement = { id: "R1", description: "runs correctly", type: "functional", priority: "required", verification: "runtime", status: "unverified", evidenceRefs: [] };
  const runtimeContract: AcceptanceContract = {
    missionId: "m-cache",
    revision: 1,
    requirements: [runtimeReq],
    requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }],
    requiredValidations: [],
    criticalFailureConditions: [],
    createdAt: new Date().toISOString()
  };

  const first = await verifier.verify(current, { acceptanceContract: runtimeContract, requirements: [runtimeReq], explicitRequirementRefs: ["R1"], artifacts: [current] });
  await verifier.verify(current, { acceptanceContract: runtimeContract, requirements: [runtimeReq], explicitRequirementRefs: ["R1"], artifacts: [current], priorVerifications: [first] });
  assert.equal(runtime.calls, 2);
});
