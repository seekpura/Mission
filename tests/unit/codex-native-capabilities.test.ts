import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_AGENT_CAPABILITY_ID,
  buildCodexNativeCapabilityCatalog,
  codexModelCapabilityId,
  codexMultiAgentCapabilityId,
  codexReasoningCapabilityId,
  parseCodexModelListPage,
  resolveCodexNativeSelection
} from "../../src/hosts/codex/codex-native-capabilities.ts";

const PAGE = {
  data: [
    {
      id: "gpt-6-codex",
      model: "gpt-6-codex",
      displayName: "GPT-6 Codex",
      description: "Primary coding model",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "Balanced" },
        { reasoningEffort: "high", description: "Deeper reasoning" }
      ],
      defaultReasoningEffort: "medium",
      isDefault: true,
      multiAgentVersion: "v2"
    },
    {
      id: "gpt-5-fast",
      model: "gpt-5-fast",
      displayName: "GPT-5 Fast",
      hidden: false,
      supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
      defaultReasoningEffort: "low",
      isDefault: false,
      multiAgentVersion: "disabled"
    },
    {
      id: "hidden-model",
      model: "hidden-model",
      displayName: "Hidden",
      hidden: true,
      supportedReasoningEfforts: [],
      isDefault: false,
      multiAgentVersion: null
    }
  ],
  nextCursor: "page-2"
};

test("Codex model/list parser and catalog expose model, reasoning and multi-agent capabilities with graph dependencies", () => {
  const page = parseCodexModelListPage(PAGE);
  assert.equal(page.nextCursor, "page-2");
  assert.equal(page.models.length, 3);

  const catalog = buildCodexNativeCapabilityCatalog(page.models);
  assert.deepEqual(catalog.models.map(model => model.model), ["gpt-6-codex", "gpt-5-fast"]);

  const modelId = codexModelCapabilityId("gpt-6-codex");
  const mediumId = codexReasoningCapabilityId("gpt-6-codex", "medium");
  const highId = codexReasoningCapabilityId("gpt-6-codex", "high");
  const multiId = codexMultiAgentCapabilityId("gpt-6-codex", "v2");

  const model = catalog.capabilities.find(capability => capability.id === modelId);
  const medium = catalog.capabilities.find(capability => capability.id === mediumId);
  const multi = catalog.capabilities.find(capability => capability.id === multiId);
  assert(model);
  assert(medium);
  assert(multi);
  assert.deepEqual(model.constraints?.requiresCapabilityRefs, [CODEX_AGENT_CAPABILITY_ID]);
  assert.deepEqual(medium.constraints?.requiresCapabilityRefs, [modelId]);
  assert.deepEqual(multi.constraints?.requiresCapabilityRefs, [modelId]);
  assert(model.native?.features?.includes("provider-default-model"));
  assert(medium.native?.features?.includes("provider-default-reasoning-effort"));
  assert(multi.native?.features?.includes("provider-native-subagents"));
  assert.equal(catalog.capabilities.some(capability => capability.id === codexModelCapabilityId("hidden-model")), false);
  assert(catalog.selectionByCapabilityId.has(highId));
});

test("Codex allowed capability refs select exact model/reasoning and multi-agent refs pin their model", () => {
  const catalog = buildCodexNativeCapabilityCatalog(parseCodexModelListPage(PAGE).models);
  assert.deepEqual(resolveCodexNativeSelection({
    catalog,
    allowedCapabilityRefs: [codexReasoningCapabilityId("gpt-6-codex", "high")]
  }), {
    model: "gpt-6-codex",
    reasoningEffort: "high"
  });

  assert.deepEqual(resolveCodexNativeSelection({
    catalog,
    allowedCapabilityRefs: [codexMultiAgentCapabilityId("gpt-6-codex", "v2")]
  }), {
    model: "gpt-6-codex"
  });
});

test("Codex native selection fails closed on stale or conflicting provider capability refs", () => {
  const catalog = buildCodexNativeCapabilityCatalog(parseCodexModelListPage(PAGE).models);
  assert.throws(() => resolveCodexNativeSelection({
    catalog,
    allowedCapabilityRefs: ["openai-codex.reasoning.stale.high"]
  }), /stale or unavailable/);

  assert.throws(() => resolveCodexNativeSelection({
    catalog,
    allowedCapabilityRefs: [
      codexModelCapabilityId("gpt-6-codex"),
      codexModelCapabilityId("gpt-5-fast")
    ]
  }), /Conflicting Codex model capability references/);

  assert.throws(() => resolveCodexNativeSelection({
    catalog,
    allowedCapabilityRefs: [codexReasoningCapabilityId("gpt-6-codex", "high")],
    configuredModel: "gpt-5-fast"
  }), /conflicts with configured model/);
});

test("Codex model/list validation rejects malformed default effort and unsupported multi-agent versions", () => {
  assert.throws(() => parseCodexModelListPage({
    data: [{
      model: "bad-default",
      displayName: "Bad",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }],
      defaultReasoningEffort: "high"
    }]
  }), /default reasoning effort high is not in supportedReasoningEfforts/);

  assert.throws(() => parseCodexModelListPage({
    data: [{
      model: "bad-version",
      displayName: "Bad",
      supportedReasoningEfforts: [],
      multiAgentVersion: "v9"
    }]
  }), /multiAgentVersion is unsupported/);
});
