import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationPlanner } from "../../src/core/verification/verification-planner.ts";
import { VerifierRegistry } from "../../src/core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../../src/core/verification/deterministic-file-check-executor.ts";
import { ProfiledVerifier } from "../../src/core/verification/profiled-verifier.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../../src/core/domain/mission.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mission-verification-")); const path = join(root, "deck.pptx"); writeFileSync(path, "not-empty");
  const artifact: Artifact = { id: "deck", missionId: "m", logicalName: "deck", type: "presentation", version: 1, status: "candidate", uri: path, contentHash: "x", producedByAttemptId: "a", sourceArtifactRefs: [], createdAt: new Date().toISOString() };
  const requirement: Requirement = { id: "r-visual", description: "Deck has strong visual hierarchy", type: "visual", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] };
  const contract: AcceptanceContract = { missionId: "m", revision: 1, requirements: [requirement], requiredArtifacts: [{ logicalName: "deck", type: "presentation", requirementRefs: [requirement.id] }], requiredValidations: [], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  return { artifact, requirement, contract };
}

test("planner creates a perceptual check for visual review requirements", () => {
  const { artifact, requirement, contract } = fixture();
  const profile = new VerificationPlanner().plan(artifact, { acceptanceContract: contract, requirements: [requirement] });
  assert.ok(profile.checks.some(check => check.method === "perceptual" && check.requirementRefs.includes(requirement.id)));
});

test("required perceptual verification is inconclusive when no capable verifier exists", async () => {
  const { artifact, requirement, contract } = fixture();
  const verifier = new ProfiledVerifier(new VerificationPlanner(), new VerifierRegistry([new DeterministicFileCheckExecutor()]));
  const result = await verifier.verify(artifact, { acceptanceContract: contract, requirements: [requirement] });
  assert.equal(result.overall, "inconclusive");
  assert.equal(result.checkResults.find(check => check.requirementRefs?.includes(requirement.id))?.status, "inconclusive");
});
