import assert from "node:assert/strict";
import test from "node:test";
import { AcceptanceEvaluator } from "../../src/core/acceptance/acceptance-evaluator.ts";
import type { AcceptanceContract } from "../../src/core/domain/mission.ts";

 test("AcceptanceEvaluator does not let one integration-level PASS satisfy a different validation", () => {
  const contract: AcceptanceContract = { missionId: "m", revision: 1, requirements: [], requiredArtifacts: [], requiredValidations: [
    { id: "integration-a", description: "A", level: "integration", requirementRefs: [] },
    { id: "integration-b", description: "B", level: "integration", requirementRefs: [] }
  ], criticalFailureConditions: [], createdAt: new Date().toISOString() };
  const result = new AcceptanceEvaluator().evaluate({ contract, requirements: [], artifacts: [], evidence: [], verifications: [{ id: "v", missionId: "m", artifactRef: "a@1", verificationProfileId: "p", verifierId: "x", level: "integration", overall: "pass", checkResults: [{ id: "validation-integration-a", status: "pass", evidenceRefs: [] }], findingRefs: [], evidenceRefs: [], createdAt: new Date().toISOString() }] });
  assert.deepEqual(result.missingValidations, ["integration-b"]);
});
