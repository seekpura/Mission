import test from "node:test";
import assert from "node:assert/strict";
import { ContextCompiler } from "../../src/core/context/context-compiler.ts";
import { CapabilityResolver } from "../../src/core/capabilities/resolver.ts";
import { initialMissionState } from "../../src/core/events/state-projector.ts";

test("context compiler scopes work context and resolver prefers available matching capability", () => {
  const state = initialMissionState("m");
  state.revision = 5; state.graphRevision = 3;
  const work: any = { id: "w", missionId: "m", objective: "render technical animation", purpose: "production", status: "ready", requirementRefs: ["r1"], gapRefs: [], inputArtifactRefs: ["storyboard@1"], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 3, createdBy: "planner", createdAt: "", updatedAt: "" };
  const packet = new ContextCompiler().compile({ state, workItem: work, constraintRefs: ["c1"], capabilityRefs: ["motion"] });
  assert.deepEqual(packet.requirementRefs, ["r1"]);
  assert.deepEqual(packet.artifactRefs, ["storyboard@1"]);
  const need: any = { id: "n", missionId: "m", objective: "motion", requiredFunctions: ["technical animation"], desiredInputs: [], desiredOutputs: [], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: [], gapRefs: [] };
  const resolution = new CapabilityResolver().resolve(need, [{ id: "motion", kind: "skill", name: "Technical Animation", description: "render technical animation diagrams", hostNative: true, available: true, permissions: [], scope: "host" }]);
  assert.equal(resolution.status, "resolved");
});
