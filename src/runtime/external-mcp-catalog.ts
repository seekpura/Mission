import { createHash } from "node:crypto";
import type { CapabilityCandidate, CapabilityNeed } from "../core/domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "../core/capabilities/discovery-provider.ts";

const CATALOG_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_REVISION = /^[A-Za-z0-9._:@+/-]{1,160}$/;
const MAX_ENTRIES = 128;
const MAX_TEXT = 2_048;
const MAX_LIST_ITEMS = 64;
const MAX_LIST_ITEM_TEXT = 256;

export interface ExternalMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  url: string;
  functions: string[];
  accepts?: string[];
  produces?: string[];
}

export interface ResolvedExternalMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  url: string;
  functions: string[];
  accepts: string[];
  produces: string[];
  candidateId: string;
  sourceUri: string;
  contentHash: string;
}

type NormalizedExternalMcpCatalogEntry = ResolvedExternalMcpCatalogEntry;

/**
 * Operator-configured discovery authority for external MCP endpoints.
 *
 * This component only validates immutable catalog identity and produces
 * bounded CapabilityCandidates. It never connects to an MCP endpoint, never
 * approves or activates a capability, and never carries credentials.
 */
export class ExternalMcpCatalogDiscoveryProvider implements CapabilityDiscoveryProvider {
  readonly id = "external-mcp-catalog";
  private readonly entries: readonly NormalizedExternalMcpCatalogEntry[];

  constructor(entries: readonly ExternalMcpCatalogEntry[]) {
    if (entries.length > MAX_ENTRIES) {
      throw new Error(`External MCP catalog exceeds ${MAX_ENTRIES} entries`);
    }

    const ids = new Set<string>();
    const names = new Set<string>();
    this.entries = entries.map(entry => {
      const normalized = normalizeEntry(entry);
      if (ids.has(normalized.id)) {
        throw new Error(`Duplicate external MCP catalog id: ${normalized.id}`);
      }
      if (names.has(normalized.name)) {
        throw new Error(`Duplicate external MCP server name: ${normalized.name}`);
      }
      ids.add(normalized.id);
      names.add(normalized.name);
      return normalized;
    });
  }

  async discover(need: CapabilityNeed): Promise<CapabilityCandidate[]> {
    const acceptableKinds = need.policy?.acceptableKinds;
    if (acceptableKinds && acceptableKinds.length > 0 && !acceptableKinds.includes("mcp")) {
      return [];
    }

    return this.entries.map(entry => ({
      id: entry.candidateId,
      sourceType: "mcp-registry",
      sourceUri: entry.sourceUri,
      name: entry.name,
      description: `${entry.description} ${entry.functions.join(" ")}`,
      candidateKind: "mcp",
      resolvedRevision: entry.revision,
      contentHash: entry.contentHash,
      status: "discovered"
    }));
  }

  resolveCandidate(candidate: CapabilityCandidate): ResolvedExternalMcpCatalogEntry {
    const entry = this.entries.find(item => item.candidateId === candidate.id);
    if (!entry) throw new Error(`External MCP candidate is not present in the configured catalog: ${candidate.id}`);
    if (
      candidate.sourceType !== "mcp-registry"
      || candidate.candidateKind !== "mcp"
      || candidate.sourceUri !== entry.sourceUri
      || candidate.name !== entry.name
      || candidate.resolvedRevision !== entry.revision
      || candidate.contentHash !== entry.contentHash
      || candidate.status !== "discovered"
    ) {
      throw new Error(`External MCP candidate immutable identity mismatch: ${candidate.id}`);
    }
    return {
      ...entry,
      functions: [...entry.functions],
      accepts: [...entry.accepts],
      produces: [...entry.produces]
    };
  }
}

export function parseExternalMcpCatalogJson(value: string | undefined): ExternalMcpCatalogEntry[] {
  if (!value?.trim()) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `External MCP catalog must be valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!Array.isArray(parsed)) throw new Error("External MCP catalog must be a JSON array");
  if (parsed.length > MAX_ENTRIES) throw new Error(`External MCP catalog exceeds ${MAX_ENTRIES} entries`);

  return parsed.map((entry, index) => {
    const parsedEntry = parseEntry(entry, index);
    const normalized = normalizeEntry(parsedEntry);
    return {
      id: normalized.id,
      name: normalized.name,
      description: normalized.description,
      revision: normalized.revision,
      url: normalized.url,
      functions: [...normalized.functions],
      ...(normalized.accepts.length > 0 ? { accepts: [...normalized.accepts] } : {}),
      ...(normalized.produces.length > 0 ? { produces: [...normalized.produces] } : {})
    };
  });
}

function normalizeEntry(entry: ExternalMcpCatalogEntry): NormalizedExternalMcpCatalogEntry {
  const id = bounded(entry.id, "External MCP id", 96);
  if (!CATALOG_ID.test(id)) throw new Error(`External MCP id must match ${CATALOG_ID}: ${id}`);

  const name = bounded(entry.name, `External MCP ${id} name`, 32);
  if (!SERVER_NAME.test(name)) throw new Error(`External MCP ${id} name must match ${SERVER_NAME}`);

  const description = bounded(entry.description, `External MCP ${id} description`, MAX_TEXT);
  const revision = bounded(entry.revision, `External MCP ${id} revision`, 160);
  if (!SAFE_REVISION.test(revision) || revision.includes("..")) {
    throw new Error(`External MCP ${id} revision is unsafe`);
  }

  const url = normalizeHttpsUrl(entry.url, id);
  const functions = stringList(entry.functions, `External MCP ${id} functions`, true);
  const accepts = stringList(entry.accepts ?? [], `External MCP ${id} accepts`, false);
  const produces = stringList(entry.produces ?? [], `External MCP ${id} produces`, false);
  const manifest = { id, name, description, revision, url, functions, accepts, produces };
  const contentHash = `sha256:${createHash("sha256").update(stableJson(manifest)).digest("hex")}`;

  return {
    ...manifest,
    candidateId: `mcp-registry:${id}`,
    sourceUri: `mcp-registry:${id}@${revision}`,
    contentHash
  };
}

function parseEntry(value: unknown, index: number): ExternalMcpCatalogEntry {
  const object = record(value, `externalMcpCatalog[${index}]`);
  return {
    id: requiredString(object.id, `externalMcpCatalog[${index}].id`),
    name: requiredString(object.name, `externalMcpCatalog[${index}].name`),
    description: requiredString(object.description, `externalMcpCatalog[${index}].description`),
    revision: requiredString(object.revision, `externalMcpCatalog[${index}].revision`),
    url: requiredString(object.url, `externalMcpCatalog[${index}].url`),
    functions: requiredStringArray(object.functions, `externalMcpCatalog[${index}].functions`),
    ...(object.accepts === undefined
      ? {}
      : { accepts: requiredStringArray(object.accepts, `externalMcpCatalog[${index}].accepts`) }),
    ...(object.produces === undefined
      ? {}
      : { produces: requiredStringArray(object.produces, `externalMcpCatalog[${index}].produces`) })
  };
}

function normalizeHttpsUrl(value: string, id: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`External MCP ${id} URL must be a valid absolute HTTPS URL`);
  }
  if (url.protocol !== "https:") throw new Error(`External MCP ${id} requires HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`External MCP ${id} URL must not contain credentials, query parameters or fragments`);
  }
  return url.toString();
}

function stringList(values: string[], label: string, required: boolean): string[] {
  if (!Array.isArray(values) || values.length > MAX_LIST_ITEMS || (required && values.length === 0)) {
    throw new Error(`${label} must contain ${required ? "1-64" : "0-64"} strings`);
  }
  const result = [...new Set(values.map((value, index) => bounded(value, `${label}[${index}]`, MAX_LIST_ITEM_TEXT)))];
  if (required && result.length === 0) throw new Error(`${label} must contain 1-64 strings`);
  return result;
}

function bounded(value: string, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const clean = value.trim();
  if (clean.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return clean;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) {
    throw new Error(`${label} must be a string array`);
  }
  return [...value] as string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
