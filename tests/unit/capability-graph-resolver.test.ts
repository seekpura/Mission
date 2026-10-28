import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import { buildCapabilityGraph } from "../../src/core/capabilities/capability-graph.ts";
import { CapabilityResolver } from "../../src/core/capabilities/resolver.ts";

function need(overrides: Partial<CapabilityNeed> = {}): CapabilityNeed {
  return {
    id: "need-1",
    missionId: "mission-graph",
    objective: "retrieve current sources",
    requiredFunctions: ["web research source retrieval"],
    desiredInputs: [],
    desiredOutputs: [],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: [],
    gapRefs: [],
    ...overrides
  };
}

const researchSkill: CapabilityDescriptor = {
  id: "acquired:research-skill",
  kind: "skill",
  name: "Research Skill",
  description: "Web research source retrieval workflow",
  hostNative: false,
  available: true,
  permissions: [],
  scope: "mission"
};

const researchMcp: CapabilityDescriptor = {
  id: "trusted-mcp:research",
  kind: "mcp",
  name: "research",
  description: "Web research source retrieval over a trusted HTTPS MCP service",
  hostNative: true,
  available: true,
  permissions: ["mcp-http-network"],
  revision: "research-v1",
  scope: "host"
};

test("resolver applies kind, delivery and trust gates before lexical score", () => {
  const resolution = new CapabilityResolver().resolve(need({
    acceptableKinds: ["mcp"],
    requiredDeliveryModes: ["acp-mcp-http"],
    acceptableTrust: ["operator-trusted"]
  }), [researchSkill, researchMcp]);

  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.capability?.id, "trusted-mcp:research");
  const skill = resolution.evaluated?.find(item => item.capabilityId === researchSkill.id);
  assert.equal(skill?.accepted, false);
  assert.match(skill?.reasons.join(" ") ?? "", /outside acceptableKinds/);
});

test("resolver fails closed on forbidden permissions and unknown cost under an explicit cost ceiling", () => {
  const blocked = new CapabilityResolver().resolve(need({
    acceptableKinds: ["mcp"],
    forbiddenPermissions: ["mcp-http-network"]
  }), [researchMcp]);
  assert.equal(blocked.status, "missing");
  assert.match(blocked.reason, /forbidden permissions/);

  const unknownCost = new CapabilityResolver().resolve(need({
    acceptableKinds: ["mcp"],
    maxCostClass: "low"
  }), [researchMcp]);
  assert.equal(unknownCost.status, "missing");
  assert.match(unknownCost.reason, /cannot prove maxCostClass/);

  const priced: CapabilityDescriptor = {
    ...researchMcp,
    id: "trusted-mcp:priced-research",
    semantics: {
      functions: ["web research source retrieval"],
      inputTypes: [],
      outputTypes: [],
      purposes: ["research"],
      deliveryModes: ["acp-mcp-http"],
      isolation: "remote",
      networkAccess: "remote-service",
      sideEffectLevel: "external",
      trust: "operator-trusted",
      costClass: "low"
    }
  };
  const allowed = new CapabilityResolver().resolve(need({
    acceptableKinds: ["mcp"],
    maxCostClass: "low"
  }), [researchMcp, priced]);
  assert.equal(allowed.status, "resolved");
  assert.equal(allowed.capability?.id, priced.id);
});

test("resolver rejects graph nodes whose declared capability dependencies are unavailable", () => {
  const dependent: CapabilityDescriptor = {
    ...researchSkill,
    id: "acquired:dependent-skill",
    semantics: {
      functions: ["web research source retrieval"],
      inputTypes: [],
      outputTypes: [],
      purposes: ["research"],
      deliveryModes: ["workspace-skill"],
      isolation: "unknown",
      networkAccess: "unknown",
      sideEffectLevel: "unknown",
      trust: "mission-acquired",
      costClass: "unknown",
      requiresCapabilityRefs: ["trusted-mcp:missing-source"]
    }
  };
  const graph = buildCapabilityGraph([dependent]);
  assert.deepEqual(graph.edges, [{ from: dependent.id, to: "trusted-mcp:missing-source", relation: "requires" }]);

  const resolution = new CapabilityResolver().resolve(need({ acceptableKinds: ["skill"] }), [dependent]);
  assert.equal(resolution.status, "missing");
  assert.match(resolution.reason, /missing capability dependencies/);
});

test("resolver supports Chinese and mixed-language required function matching", () => {
  const capability: CapabilityDescriptor = {
    id: "skill:technical-animation",
    kind: "skill",
    name: "技术动画",
    description: "用于技术动画图示、产品结构运动演示和 technical animation production",
    hostNative: false,
    available: true,
    permissions: [],
    scope: "mission"
  };
  const resolution = new CapabilityResolver().resolve(need({
    objective: "制作技术动画",
    requiredFunctions: ["技术动画"],
    purpose: "production",
    acceptableKinds: ["skill"],
    requiredDeliveryModes: ["workspace-skill"]
  }), [capability]);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.capability?.id, capability.id);
  assert.equal(resolution.evaluated?.[0]?.functionCoverage, 1);
});

test("resolver requires every required function rather than selecting a partial keyword match", () => {
  const resolution = new CapabilityResolver().resolve(need({
    requiredFunctions: ["web research", "video rendering"]
  }), [researchMcp]);
  assert.equal(resolution.status, "missing");
  assert.match(resolution.reason, /video rendering/);
});
