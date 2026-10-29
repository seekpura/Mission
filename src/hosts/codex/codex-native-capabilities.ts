import type { CapabilityDescriptor } from "../../core/domain/capability.ts";

export const CODEX_AGENT_CAPABILITY_ID = "openai-codex.app-server-agent";
export const CODEX_MODEL_CAPABILITY_PREFIX = "openai-codex.model.";
export const CODEX_REASONING_CAPABILITY_PREFIX = "openai-codex.reasoning.";
export const CODEX_MULTI_AGENT_CAPABILITY_PREFIX = "openai-codex.multi-agent.";

const MAX_MODELS = 256;
const MAX_REASONING_EFFORTS = 16;
const MAX_TEXT = 2_048;
const PURPOSES = ["production", "verification", "research", "integration"] as const;

export interface CodexReasoningEffort {
  reasoningEffort: string;
  description?: string;
}

export interface CodexModelCatalogEntry {
  id: string;
  model: string;
  displayName: string;
  description?: string;
  hidden: boolean;
  supportedReasoningEfforts: CodexReasoningEffort[];
  defaultReasoningEffort?: string;
  isDefault: boolean;
  multiAgentVersion?: "disabled" | "v1" | "v2";
}

export interface CodexModelListPage {
  models: CodexModelCatalogEntry[];
  nextCursor?: string;
}

export interface CodexNativeSelection {
  model?: string;
  reasoningEffort?: string;
}

interface SelectionBinding {
  model: string;
  reasoningEffort?: string;
  kind: "model" | "reasoning" | "multi-agent";
}

export interface CodexNativeCapabilityCatalog {
  models: CodexModelCatalogEntry[];
  capabilities: CapabilityDescriptor[];
  selectionByCapabilityId: ReadonlyMap<string, SelectionBinding>;
}

export function parseCodexModelListPage(value: unknown): CodexModelListPage {
  const object = record(value, "Codex model/list response");
  if (!Array.isArray(object.data)) throw new Error("Codex model/list response.data must be an array");
  if (object.data.length > MAX_MODELS) throw new Error(`Codex model/list returned more than ${MAX_MODELS} models in one page`);
  const models = object.data.map((item, index) => parseModel(item, index));
  const nextCursor = optionalBoundedString(object.nextCursor, "Codex model/list nextCursor", 1_024);
  return { models, ...(nextCursor ? { nextCursor } : {}) };
}

export function buildCodexNativeCapabilityCatalog(entries: readonly CodexModelCatalogEntry[]): CodexNativeCapabilityCatalog {
  if (entries.length > MAX_MODELS) throw new Error(`Codex model catalog exceeds ${MAX_MODELS} models`);
  const models: CodexModelCatalogEntry[] = [];
  const capabilities: CapabilityDescriptor[] = [];
  const selectionByCapabilityId = new Map<string, SelectionBinding>();
  const seenModels = new Set<string>();

  for (const input of entries) {
    const entry = normalizeEntry(input);
    if (entry.hidden) continue;
    if (seenModels.has(entry.model)) throw new Error(`Codex model catalog contains duplicate model: ${entry.model}`);
    seenModels.add(entry.model);
    models.push(entry);

    const modelId = codexModelCapabilityId(entry.model);
    capabilities.push({
      id: modelId,
      kind: "runtime",
      name: `Codex model: ${entry.displayName}`,
      description: entry.description || `Provider-native Codex model ${entry.model}.`,
      hostNative: true,
      available: true,
      permissions: [],
      scope: "host",
      functions: ["select provider-native model", "execute mission work with selected model"],
      accepts: ["model preference", "mission work"],
      produces: ["provider model selection"],
      constraints: {
        requiresCapabilityRefs: [CODEX_AGENT_CAPABILITY_ID],
        supportedPurposes: [...PURPOSES]
      },
      routing: {
        executionMode: "host-agent",
        resumable: true,
        concurrent: true,
        isolation: "host"
      },
      cost: { monetaryClass: "unknown", latencyClass: "interactive", metered: true },
      native: {
        provider: "openai-codex",
        nativeId: `model:${entry.model}`,
        protocol: "codex-app-server-jsonrpc-v2",
        loadMode: "preinstalled",
        features: [
          "provider-model-selection",
          ...(entry.isDefault ? ["provider-default-model"] : []),
          ...(entry.multiAgentVersion && entry.multiAgentVersion !== "disabled"
            ? [`provider-multi-agent-${entry.multiAgentVersion}`]
            : [])
        ]
      },
      provenance: { source: "host", sourceRef: "codex app-server model/list" }
    });
    selectionByCapabilityId.set(modelId, { model: entry.model, kind: "model" });

    for (const effort of entry.supportedReasoningEfforts) {
      const reasoningId = codexReasoningCapabilityId(entry.model, effort.reasoningEffort);
      capabilities.push({
        id: reasoningId,
        kind: "runtime",
        name: `Codex reasoning: ${entry.displayName} / ${effort.reasoningEffort}`,
        description: effort.description || `Provider-native ${effort.reasoningEffort} reasoning effort for ${entry.model}.`,
        hostNative: true,
        available: true,
        permissions: [],
        scope: "host",
        functions: ["select provider-native reasoning effort", "execute mission work with selected reasoning effort"],
        accepts: ["reasoning preference", "mission work"],
        produces: ["provider reasoning selection"],
        constraints: {
          requiresCapabilityRefs: [modelId],
          supportedPurposes: [...PURPOSES]
        },
        routing: {
          executionMode: "host-agent",
          resumable: true,
          concurrent: true,
          isolation: "host"
        },
        cost: { monetaryClass: "unknown", latencyClass: "interactive", metered: true },
        native: {
          provider: "openai-codex",
          nativeId: `reasoning:${entry.model}:${effort.reasoningEffort}`,
          protocol: "codex-app-server-jsonrpc-v2",
          loadMode: "preinstalled",
          features: [
            "provider-reasoning-selection",
            ...(entry.defaultReasoningEffort === effort.reasoningEffort ? ["provider-default-reasoning-effort"] : [])
          ]
        },
        provenance: { source: "host", sourceRef: "codex app-server model/list" }
      });
      selectionByCapabilityId.set(reasoningId, {
        model: entry.model,
        reasoningEffort: effort.reasoningEffort,
        kind: "reasoning"
      });
    }

    if (entry.multiAgentVersion && entry.multiAgentVersion !== "disabled") {
      const multiAgentId = codexMultiAgentCapabilityId(entry.model, entry.multiAgentVersion);
      capabilities.push({
        id: multiAgentId,
        kind: "runtime",
        name: `Codex multi-agent delegation: ${entry.displayName} / ${entry.multiAgentVersion}`,
        description: `Provider-native multi-agent delegation exposed by ${entry.model} (${entry.multiAgentVersion}).`,
        hostNative: true,
        available: true,
        permissions: [],
        scope: "host",
        functions: ["delegate work to provider-native subagents", "coordinate provider-native multi-agent work"],
        accepts: ["delegated mission work", "parallelizable work"],
        produces: ["provider-native subagent delegation"],
        constraints: {
          requiresCapabilityRefs: [modelId],
          supportedPurposes: [...PURPOSES]
        },
        routing: {
          executionMode: "host-agent",
          resumable: true,
          concurrent: true,
          isolation: "host"
        },
        cost: { monetaryClass: "unknown", latencyClass: "interactive", metered: true },
        native: {
          provider: "openai-codex",
          nativeId: `multi-agent:${entry.model}:${entry.multiAgentVersion}`,
          protocol: "codex-app-server-jsonrpc-v2",
          loadMode: "preinstalled",
          features: ["provider-native-subagents", `provider-multi-agent-${entry.multiAgentVersion}`]
        },
        provenance: { source: "host", sourceRef: "codex app-server model/list" }
      });
      selectionByCapabilityId.set(multiAgentId, { model: entry.model, kind: "multi-agent" });
    }
  }

  return { models, capabilities, selectionByCapabilityId };
}

export function resolveCodexNativeSelection(input: {
  catalog: CodexNativeCapabilityCatalog;
  allowedCapabilityRefs: readonly string[];
  configuredModel?: string;
  configuredReasoningEffort?: string;
}): CodexNativeSelection {
  let selectedModel: string | undefined;
  let selectedEffort: string | undefined;

  for (const ref of input.allowedCapabilityRefs) {
    const binding = input.catalog.selectionByCapabilityId.get(ref);
    if (!binding) {
      if (isCodexNativeSelectionCapabilityRef(ref)) {
        throw new Error(`Codex native capability reference is stale or unavailable: ${ref}`);
      }
      continue;
    }
    if (selectedModel && selectedModel !== binding.model) {
      throw new Error(`Conflicting Codex model capability references: ${selectedModel} and ${binding.model}`);
    }
    selectedModel = binding.model;
    if (binding.reasoningEffort) {
      if (selectedEffort && selectedEffort !== binding.reasoningEffort) {
        throw new Error(`Conflicting Codex reasoning capability references: ${selectedEffort} and ${binding.reasoningEffort}`);
      }
      selectedEffort = binding.reasoningEffort;
    }
  }

  const configuredModel = cleanOptional(input.configuredModel);
  const configuredEffort = cleanOptional(input.configuredReasoningEffort);
  if (configuredModel && selectedModel && configuredModel !== selectedModel) {
    throw new Error(`Selected Codex model ${selectedModel} conflicts with configured model ${configuredModel}`);
  }
  if (configuredEffort && selectedEffort && configuredEffort !== selectedEffort) {
    throw new Error(`Selected Codex reasoning effort ${selectedEffort} conflicts with configured effort ${configuredEffort}`);
  }

  const model = selectedModel ?? configuredModel;
  const reasoningEffort = selectedEffort ?? configuredEffort;
  if (selectedEffort && !model) throw new Error("Selected Codex reasoning effort requires a model");
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {})
  };
}

export function codexModelCapabilityId(model: string): string {
  return `${CODEX_MODEL_CAPABILITY_PREFIX}${encodeSegment(model)}`;
}

export function codexReasoningCapabilityId(model: string, effort: string): string {
  return `${CODEX_REASONING_CAPABILITY_PREFIX}${encodeSegment(model)}.${encodeSegment(effort)}`;
}

export function codexMultiAgentCapabilityId(model: string, version: "v1" | "v2"): string {
  return `${CODEX_MULTI_AGENT_CAPABILITY_PREFIX}${encodeSegment(model)}.${version}`;
}

export function isCodexNativeSelectionCapabilityRef(ref: string): boolean {
  return ref.startsWith(CODEX_MODEL_CAPABILITY_PREFIX)
    || ref.startsWith(CODEX_REASONING_CAPABILITY_PREFIX)
    || ref.startsWith(CODEX_MULTI_AGENT_CAPABILITY_PREFIX);
}

function parseModel(value: unknown, index: number): CodexModelCatalogEntry {
  const object = record(value, `Codex model/list data[${index}]`);
  const model = boundedString(object.model, `Codex model/list data[${index}].model`, 256);
  const id = optionalBoundedString(object.id, `Codex model/list data[${index}].id`, 256) ?? model;
  const displayName = optionalBoundedString(object.displayName, `Codex model/list data[${index}].displayName`, 256) ?? model;
  const description = optionalBoundedString(object.description, `Codex model/list data[${index}].description`, MAX_TEXT);
  const hidden = optionalBoolean(object.hidden, `Codex model/list data[${index}].hidden`) ?? false;
  const isDefault = optionalBoolean(object.isDefault, `Codex model/list data[${index}].isDefault`) ?? false;
  const supported = object.supportedReasoningEfforts;
  if (supported !== undefined && !Array.isArray(supported)) {
    throw new Error(`Codex model/list data[${index}].supportedReasoningEfforts must be an array`);
  }
  if (Array.isArray(supported) && supported.length > MAX_REASONING_EFFORTS) {
    throw new Error(`Codex model/list data[${index}] exposes more than ${MAX_REASONING_EFFORTS} reasoning efforts`);
  }
  const supportedReasoningEfforts = (supported ?? []).map((item, effortIndex) => {
    const effort = record(item, `Codex model/list data[${index}].supportedReasoningEfforts[${effortIndex}]`);
    return {
      reasoningEffort: boundedString(
        effort.reasoningEffort,
        `Codex model/list data[${index}].supportedReasoningEfforts[${effortIndex}].reasoningEffort`,
        64
      ),
      ...(optionalBoundedString(
        effort.description,
        `Codex model/list data[${index}].supportedReasoningEfforts[${effortIndex}].description`,
        MAX_TEXT
      ) ? { description: String(effort.description).trim() } : {})
    };
  });
  const defaultReasoningEffort = optionalBoundedString(
    object.defaultReasoningEffort,
    `Codex model/list data[${index}].defaultReasoningEffort`,
    64
  );
  const rawMultiAgent = object.multiAgentVersion;
  if (rawMultiAgent !== undefined && rawMultiAgent !== null && rawMultiAgent !== "disabled" && rawMultiAgent !== "v1" && rawMultiAgent !== "v2") {
    throw new Error(`Codex model/list data[${index}].multiAgentVersion is unsupported: ${String(rawMultiAgent)}`);
  }
  return normalizeEntry({
    id,
    model,
    displayName,
    ...(description ? { description } : {}),
    hidden,
    supportedReasoningEfforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    isDefault,
    ...(rawMultiAgent && rawMultiAgent !== null ? { multiAgentVersion: rawMultiAgent as "disabled" | "v1" | "v2" } : {})
  });
}

function normalizeEntry(entry: CodexModelCatalogEntry): CodexModelCatalogEntry {
  const model = boundedString(entry.model, "Codex model", 256);
  const id = boundedString(entry.id || model, "Codex model id", 256);
  const displayName = boundedString(entry.displayName || model, "Codex model displayName", 256);
  const description = cleanOptional(entry.description);
  if (description && description.length > MAX_TEXT) throw new Error(`Codex model description exceeds ${MAX_TEXT} characters`);
  if (entry.supportedReasoningEfforts.length > MAX_REASONING_EFFORTS) {
    throw new Error(`Codex model ${model} exposes more than ${MAX_REASONING_EFFORTS} reasoning efforts`);
  }
  const efforts = entry.supportedReasoningEfforts.map(effort => ({
    reasoningEffort: boundedString(effort.reasoningEffort, "Codex reasoning effort", 64),
    ...(cleanOptional(effort.description) ? { description: cleanOptional(effort.description) } : {})
  }));
  const seen = new Set<string>();
  for (const effort of efforts) {
    if (seen.has(effort.reasoningEffort)) throw new Error(`Codex model ${model} contains duplicate reasoning effort ${effort.reasoningEffort}`);
    seen.add(effort.reasoningEffort);
  }
  const defaultReasoningEffort = cleanOptional(entry.defaultReasoningEffort);
  if (defaultReasoningEffort && !seen.has(defaultReasoningEffort)) {
    throw new Error(`Codex model ${model} default reasoning effort ${defaultReasoningEffort} is not in supportedReasoningEfforts`);
  }
  return {
    id,
    model,
    displayName,
    ...(description ? { description } : {}),
    hidden: Boolean(entry.hidden),
    supportedReasoningEfforts: efforts,
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    isDefault: Boolean(entry.isDefault),
    ...(entry.multiAgentVersion ? { multiAgentVersion: entry.multiAgentVersion } : {})
  };
}

function encodeSegment(value: string): string {
  const bounded = boundedString(value, "Codex native capability segment", 256);
  return Buffer.from(bounded, "utf8").toString("base64url");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return clean;
}

function optionalBoundedString(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedString(value, label, max);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean when supplied`);
  return value;
}

function cleanOptional(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
