import assert from "node:assert/strict";
import test from "node:test";
import { buildHostCapabilityGraph } from "../../src/core/capabilities/capability-graph.ts";
import { CapabilityResolver } from "../../src/core/capabilities/resolver.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import { DeepSeekHarnessAdapter, type DeepSeekBindings } from "../../src/hosts/deepseek/deepseek-host-adapter.ts";
import {
  CODEX_AGENT_CAPABILITY_ID,
  buildCodexNativeCapabilityCatalog,
  parseCodexModelListPage
} from "../../src/hosts/codex/codex-native-capabilities.ts";

function need(overrides: Partial<CapabilityNeed>): CapabilityNeed {
  return {
    id: "need-provider-native",
    missionId: "mission-provider-native",
    objective: "use provider-native execution semantics",
    requiredFunctions: [],
    desiredInputs: [],
    desiredOutputs: [],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: false,
    maxRisk: "low",
    requirementRefs: [],
    gapRefs: [],
    ...overrides
  };
}

const codexAgent: CapabilityDescriptor = {
  id: CODEX_AGENT_CAPABILITY_ID,
  kind: "agent",
  name: "OpenAI Codex app-server Agent",
  description: "Codex native agent",
  hostNative: true,
  available: true,
  permissions: [],
  scope: "host",
  functions: ["execute mission work"],
  routing: { executionMode: "host-agent" },
  native: { provider: "openai-codex", features: ["thread-start"] },
  provenance: { source: "host" }
};

function codexGraph() {
  const catalog = buildCodexNativeCapabilityCatalog(parseCodexModelListPage({
    data: [{
      model: "gpt-6-codex",
      displayName: "GPT-6 Codex",
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "balanced" },
        { reasoningEffort: "high", description: "deep" }
      ],
      defaultReasoningEffort: "medium",
      isDefault: true,
      hidden: false,
      multiAgentVersion: "v2"
    }]
  }).models);
  return buildHostCapabilityGraph({
    revision: 4,
    host: { type: "openai-codex" },
    capabilities: [codexAgent, ...catalog.capabilities],
    shellAvailable: true,
    filesystemAvailable: true,
    browserAvailable: false
  });
}

test("CapabilityResolver can select Codex reasoning and multi-agent semantics from the real capability graph", () => {
  const graph = codexGraph();
  const reasoning = new CapabilityResolver().resolve(need({
    requiredFunctions: ["select provider-native reasoning effort"],
    policy: {
      acceptableKinds: ["runtime"],
      acceptableProviders: ["openai-codex"],
      requiredNativeFeatures: ["provider-reasoning-selection"]
    }
  }), graph);
  assert.equal(reasoning.status, "resolved");
  assert(reasoning.capability?.id.startsWith("openai-codex.reasoning."));

  const multiAgent = new CapabilityResolver().resolve(need({
    requiredFunctions: ["delegate work to provider-native subagents"],
    policy: {
      acceptableKinds: ["runtime"],
      acceptableProviders: ["openai-codex"],
      requiredNativeFeatures: ["provider-native-subagents", "provider-multi-agent-v2"]
    }
  }), graph);
  assert.equal(multiAgent.status, "resolved");
  assert(multiAgent.capability?.id.startsWith("openai-codex.multi-agent."));
});

test("CapabilityResolver does not invent stable background jobs when Codex experimental API is disabled", () => {
  const result = new CapabilityResolver().resolve(need({
    requiredFunctions: ["execute provider-native background job"],
    policy: { acceptableProviders: ["openai-codex"] }
  }), codexGraph());
  assert.equal(result.status, "missing");
});

test("DeepSeek ACP snapshot stays truthful when its stable v1 environment exposes no pre-session model/reasoning catalog", async () => {
  const bindings: DeepSeekBindings = {
    async describe() { return { type: "deepseek-harness", version: "fixture" }; },
    async environment() {
      return {
        revision: 1,
        host: { type: "deepseek-harness", version: "fixture" },
        capabilities: [{
          id: "deepseek-harness.acp-agent",
          kind: "agent",
          name: "DeepSeek ACP Agent",
          description: "Stable ACP v1 agent session",
          hostNative: true,
          available: true,
          permissions: [],
          scope: "host"
        }],
        shellAvailable: true,
        filesystemAvailable: true,
        browserAvailable: false,
        capturedAt: "2026-10-29T00:00:00.000Z"
      };
    },
    async createAgent() { throw new Error("not used"); },
    async resumeAgent() { return { status: "unsupported", reason: "not used" }; },
    async steerAgent() {},
    async cancelAgent() {},
    async *observeAgent() {},
    async invokeCapability() { return { ok: false, error: "not used" }; },
    async requestApproval() { return { approved: false }; }
  };
  const snapshot = await new DeepSeekHarnessAdapter(bindings).snapshotEnvironment();
  assert.equal(snapshot.capabilities.some(capability => capability.id.includes("model")), false);
  assert.equal(snapshot.capabilities.some(capability => capability.id.includes("reasoning")), false);
  assert.equal(snapshot.capabilities.some(capability => capability.native?.features?.includes("provider-native-subagents")), false);
  assert.equal(snapshot.capabilities.some(capability => capability.functions?.some(fn => fn.includes("background job"))), false);
});
