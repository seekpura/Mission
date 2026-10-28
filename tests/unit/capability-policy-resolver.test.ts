import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import { CapabilityResolver } from "../../src/core/capabilities/resolver.ts";

function need(overrides: Partial<CapabilityNeed> = {}): CapabilityNeed {
  return {
    id: "need-policy",
    missionId: "mission-policy",
    objective: "retrieve current research evidence",
    requiredFunctions: ["web research source retrieval"],
    desiredInputs: [],
    desiredOutputs: [],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: false,
    maxRisk: "low",
    requirementRefs: [],
    gapRefs: [],
    ...overrides
  };
}

const trustedResearchMcp: CapabilityDescriptor = {
  id: "trusted-mcp:research",
  kind: "mcp",
  name: "Research MCP",
  description: "Trusted research service",
  hostNative: true,
  available: true,
  permissions: ["mcp-http-network"],
  scope: "host",
  functions: ["web research source retrieval"],
  constraints: { supportedPurposes: ["research", "production"] },
  routing: { executionMode: "remote-service", isolation: "remote", resumable: true },
  cost: { monetaryClass: "low", latencyClass: "remote", metered: true },
  native: {
    provider: "trusted-mcp",
    nativeId: "research",
    protocol: "mcp-http",
    loadMode: "remote",
    features: ["search", "citations"],
    persistence: ["session", "resume"]
  },
  provenance: { source: "host", sourceRef: "operator-config", revision: "v1" }
};

const acquiredSkill: CapabilityDescriptor = {
  id: "acquired:research-skill",
  kind: "skill",
  name: "Research Skill",
  description: "Web research source retrieval instructions",
  hostNative: false,
  available: true,
  permissions: [],
  scope: "mission",
  functions: ["web research source retrieval"],
  constraints: { supportedPurposes: ["research", "production"] },
  routing: { executionMode: "mission-context", isolation: "instruction-only" },
  cost: { monetaryClass: "negligible", latencyClass: "local", metered: false },
  native: { provider: "deepseek-harness", loadMode: "mission-overlay", features: ["skill-catalog"] },
  provenance: { source: "mission", revision: "commit-1" }
};

test("CapabilityNeed policy hard-gates kind, execution mode, provider, feature and provenance before semantic ranking", () => {
  const result = new CapabilityResolver().resolve(need({
    policy: {
      acceptableKinds: ["mcp"],
      requiredExecutionModes: ["remote-service"],
      acceptableProviders: ["trusted-mcp"],
      requiredNativeFeatures: ["citations"],
      acceptableProvenanceSources: ["host"],
      maxMonetaryClass: "low"
    }
  }), [acquiredSkill, trustedResearchMcp]);

  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "trusted-mcp:research");
  assert.match(result.reason, /CapabilityNeed policy constraints satisfied/);
});

test("CapabilityNeed policy fails closed on forbidden permissions and unknown or excessive cost", () => {
  const forbidden = new CapabilityResolver().resolve(need({
    policy: { forbiddenPermissions: ["mcp-http-network"] }
  }), [trustedResearchMcp]);
  assert.equal(forbidden.status, "missing");
  assert.match(forbidden.reason, /forbidden permissions/);

  const unknownCost: CapabilityDescriptor = {
    ...trustedResearchMcp,
    id: "trusted-mcp:unknown-cost",
    cost: { latencyClass: "remote", metered: true }
  };
  const cost = new CapabilityResolver().resolve(need({
    policy: { maxMonetaryClass: "low" }
  }), [unknownCost]);
  assert.equal(cost.status, "missing");
  assert.match(cost.reason, /cannot prove maxMonetaryClass/);
});

test("CapabilityNeed policy rejects missing provider-native features rather than trusting a matching name", () => {
  const result = new CapabilityResolver().resolve(need({
    policy: {
      acceptableKinds: ["mcp"],
      requiredNativeFeatures: ["browser-rendered-evidence"]
    }
  }), [trustedResearchMcp]);
  assert.equal(result.status, "missing");
  assert.match(result.reason, /missing native features/);
});

test("multilingual semantic matching resolves Chinese capability functions", () => {
  const capability: CapabilityDescriptor = {
    id: "skill:technical-animation",
    kind: "skill",
    name: "技术动画",
    description: "用于产品结构运动演示",
    hostNative: false,
    available: true,
    permissions: [],
    scope: "mission",
    functions: ["技术动画制作", "产品结构运动演示"],
    constraints: { supportedPurposes: ["production"] },
    routing: { executionMode: "mission-context", isolation: "instruction-only" },
    provenance: { source: "mission", revision: "v1" }
  };

  const result = new CapabilityResolver().resolve(need({
    objective: "制作技术动画",
    requiredFunctions: ["技术动画"],
    purpose: "production"
  }), [capability]);
  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, capability.id);
});

test("all required function phrases must be covered", () => {
  const result = new CapabilityResolver().resolve(need({
    requiredFunctions: ["web research source retrieval", "video rendering"]
  }), [trustedResearchMcp]);
  assert.equal(result.status, "missing");
  assert.match(result.reason, /video rendering/);
});
