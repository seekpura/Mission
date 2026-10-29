import { createHash, randomUUID } from "node:crypto";
import type {
  CapabilityCandidate,
  CapabilityDescriptor,
  CapabilityNeed,
  SecurityAssessment
} from "../core/domain/capability.ts";
import type {
  CapabilityEnsureResult,
  CapabilityRuntime
} from "../core/capabilities/capability-coordinator.ts";
import { CandidateRanker, type RankedCandidate } from "../core/capabilities/candidate-ranker.ts";
import type { AcquisitionReceiptStore } from "../core/capabilities/acquisition-receipt.ts";
import type { AcquisitionApprovalBroker } from "../core/capabilities/acquisition-transaction.ts";
import type { PolicyDecision } from "../core/policy/policy-engine.ts";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor,
  HostMcpServer
} from "../hosts/host-adapter.ts";

const CATALOG_ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const SAFE_REVISION = /^[A-Za-z0-9._:@+/-]{1,160}$/;
const EXTERNAL_CAPABILITY_PREFIX = "external-mcp:";
const MAX_ENTRIES = 128;
const MAX_TEXT = 2_048;
const RISK_RANK = { low: 0, medium: 1, high: 2, blocked: 3 } as const;

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

interface NormalizedExternalMcpEntry extends ExternalMcpCatalogEntry {
  url: string;
  contentHash: string;
  candidateId: string;
  capabilityId: string;
}

interface MissionMcpEntry {
  capability: CapabilityDescriptor;
  server: HostMcpServer;
}

export class ExternalMcpCatalog {
  private readonly entries: NormalizedExternalMcpEntry[];
  private readonly byCandidateId = new Map<string, NormalizedExternalMcpEntry>();

  constructor(entries: ExternalMcpCatalogEntry[]) {
    if (entries.length > MAX_ENTRIES) throw new Error(`External MCP catalog exceeds ${MAX_ENTRIES} entries`);
    const ids = new Set<string>();
    const names = new Set<string>();
    this.entries = entries.map(entry => {
      const normalized = normalizeEntry(entry);
      if (ids.has(normalized.id)) throw new Error(`Duplicate external MCP catalog id: ${normalized.id}`);
      if (names.has(normalized.name)) throw new Error(`Duplicate external MCP server name: ${normalized.name}`);
      ids.add(normalized.id);
      names.add(normalized.name);
      this.byCandidateId.set(normalized.candidateId, normalized);
      return normalized;
    });
  }

  size(): number {
    return this.entries.length;
  }

  discover(need: CapabilityNeed): RankedCandidate[] {
    const candidates = this.entries.map(entry => candidateFromEntry(entry));
    return new CandidateRanker().rank(need, candidates);
  }

  requireCandidate(candidate: CapabilityCandidate): NormalizedExternalMcpEntry {
    const entry = this.byCandidateId.get(candidate.id);
    if (!entry || candidate.sourceType !== "mcp-registry" || candidate.candidateKind !== "mcp") {
      throw new Error(`External MCP candidate is not present in the configured catalog: ${candidate.id}`);
    }
    if (candidate.sourceUri !== sourceUri(entry)) {
      throw new Error(`External MCP candidate source identity changed: ${candidate.id}`);
    }
    return entry;
  }
}

/**
 * In-memory delivery authority for acquired no-secret HTTPS MCP capabilities.
 * Durable recovery rehydrates this registry from capability.activated records;
 * the descriptor contains only non-secret server identity and URL.
 */
export class MissionExternalMcpRegistry {
  private readonly byMission = new Map<string, Map<string, MissionMcpEntry>>();

  activate(missionId: string, capability: CapabilityDescriptor): void {
    const entry = deliveryEntryFromCapability(capability);
    if (!entry) return;
    const current = this.byMission.get(missionId) ?? new Map<string, MissionMcpEntry>();
    current.set(capability.id, entry);
    this.byMission.set(missionId, current);
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    const next = new Map<string, MissionMcpEntry>();
    for (const capability of capabilities) {
      const entry = deliveryEntryFromCapability(capability);
      if (entry) next.set(capability.id, entry);
    }
    if (next.size === 0) this.byMission.delete(missionId);
    else this.byMission.set(missionId, next);
  }

  deactivate(missionId: string, capabilityId: string): void {
    const current = this.byMission.get(missionId);
    if (!current) return;
    current.delete(capabilityId);
    if (current.size === 0) this.byMission.delete(missionId);
  }

  select(missionId: string, capabilityRefs: readonly string[]): HostMcpServer[] {
    const current = this.byMission.get(missionId);
    const servers: HostMcpServer[] = [];
    const names = new Set<string>();
    for (const ref of new Set(capabilityRefs)) {
      const entry = current?.get(ref);
      if (!entry) {
        if (ref.startsWith(EXTERNAL_CAPABILITY_PREFIX)) {
          throw new Error(`External MCP capability is not activated for Mission ${missionId}: ${ref}`);
        }
        continue;
      }
      if (names.has(entry.server.name)) throw new Error(`Duplicate mission MCP server name: ${entry.server.name}`);
      names.add(entry.server.name);
      servers.push(cloneServer(entry.server));
    }
    return servers;
  }
}

/** Merge mission-local acquired MCP declarations after the trusted outer adapter
 * has admitted caller input, but before provider-native session creation. */
export class MissionExternalMcpHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly registry: MissionExternalMcpRegistry;

  constructor(base: HostAdapter, registry: MissionExternalMcpRegistry) {
    this.base = base;
    this.registry = registry;
  }

  describeHost(): Promise<HostDescriptor> { return this.base.describeHost(); }
  snapshotEnvironment(): Promise<EnvironmentSnapshot> { return this.base.snapshotEnvironment(); }

  createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    return this.base.createAgent(withMissionMcp(request, this.registry));
  }

  resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return this.base.resumeAgent(withMissionMcp(request, this.registry));
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> { return this.base.steerAgent(handle, delta); }
  cancelAgent(handle: HostAgentHandle): Promise<void> { return this.base.cancelAgent(handle); }
  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> { return this.base.observeAgent(handle); }
  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return this.base.invokeHostCapability(request); }
  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> { return this.base.requestUserApproval(request); }
}

export class ExternalMcpAcquirer {
  private readonly catalog: ExternalMcpCatalog;
  private readonly approvals: AcquisitionApprovalBroker;
  private readonly receipts: AcquisitionReceiptStore;
  private readonly registry: MissionExternalMcpRegistry;

  constructor(options: {
    catalog: ExternalMcpCatalog;
    approvals: AcquisitionApprovalBroker;
    receipts: AcquisitionReceiptStore;
    registry: MissionExternalMcpRegistry;
  }) {
    this.catalog = options.catalog;
    this.approvals = options.approvals;
    this.receipts = options.receipts;
    this.registry = options.registry;
  }

  async acquire(candidate: CapabilityCandidate, need: CapabilityNeed) {
    if (!need.acquisitionAllowed) throw new Error(`Capability acquisition is disabled for need ${need.id}`);
    const entry = this.catalog.requireCandidate(candidate);
    const security = securityAssessment(entry);
    const policy = externalMcpPolicy();
    if (RISK_RANK[security.overall] > RISK_RANK[need.maxRisk]) {
      const receipt = makeReceipt(entry, candidate, need, security, policy, "rejected", `External MCP risk ${security.overall} exceeds need maxRisk ${need.maxRisk}`);
      await this.receipts.save(receipt);
      throw new Error(receipt.reason);
    }

    const decision = await this.approvals.requestApproval({
      missionId: need.missionId,
      candidateId: candidate.id,
      capabilityNeedId: need.id,
      title: `Approve external MCP: ${entry.name}`,
      reason: "External MCP servers can receive Mission context and expose remote tools. Activation is mission-local and requires explicit approval.",
      details: {
        sourceType: "mcp-registry",
        registryId: entry.id,
        serverName: entry.name,
        endpointOrigin: new URL(entry.url).origin,
        revision: entry.revision,
        contentHash: entry.contentHash,
        functions: [...entry.functions],
        credentials: "none",
        transport: "streamable-http-https"
      }
    });
    const approval = {
      approved: decision.approved,
      ...(decision.actor ? { actor: decision.actor } : {}),
      decidedAt: new Date().toISOString()
    };
    if (!decision.approved) {
      const receipt = makeReceipt(entry, candidate, need, security, policy, "approval_rejected", "User rejected external MCP activation", approval);
      await this.receipts.save(receipt);
      throw new Error(receipt.reason);
    }

    const capability = capabilityFromEntry(entry);
    this.registry.activate(need.missionId, capability);
    const receipt = makeReceipt(entry, candidate, need, security, policy, "activated", undefined, approval, capability);
    try {
      await this.receipts.save(receipt);
    } catch (error) {
      this.registry.deactivate(need.missionId, capability.id);
      throw error;
    }
    return { capability, receipt };
  }
}

/**
 * Adds external MCP acquisition to an existing CapabilityRuntime without
 * changing Agent Skill acquisition semantics. Existing resolution/acquisition
 * gets first choice; external MCP is attempted only when it remains unresolved.
 */
export class ExternalMcpCapabilityRuntime implements CapabilityRuntime {
  private readonly base: CapabilityRuntime;
  private readonly catalog: ExternalMcpCatalog;
  private readonly acquirer: ExternalMcpAcquirer;
  private readonly registry: MissionExternalMcpRegistry;
  private readonly maxCandidates: number;

  constructor(options: {
    base: CapabilityRuntime;
    catalog: ExternalMcpCatalog;
    acquirer: ExternalMcpAcquirer;
    registry: MissionExternalMcpRegistry;
    maxCandidates?: number;
  }) {
    this.base = options.base;
    this.catalog = options.catalog;
    this.acquirer = options.acquirer;
    this.registry = options.registry;
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 4);
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    const list = [...capabilities];
    this.base.restoreMissionCapabilities(missionId, list);
    this.registry.restoreMissionCapabilities(missionId, list);
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.base.deactivateMissionCapability(missionId, capabilityId);
    this.registry.deactivate(missionId, capabilityId);
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    const base = await this.base.ensure(need);
    if (base.status === "resolved" || !need.acquisitionAllowed || !this.mcpAllowed(need)) return base;
    const ranked = this.catalog.discover(need);
    if (ranked.length === 0) return base;

    const attempts = [...base.attempts];
    for (const rankedCandidate of ranked.slice(0, this.maxCandidates)) {
      try {
        const acquired = await this.acquirer.acquire(rankedCandidate.candidate, need);
        attempts.push({
          candidateId: rankedCandidate.candidate.id,
          candidateName: rankedCandidate.candidate.name,
          ok: true
        });
        return {
          status: "resolved",
          capability: acquired.capability,
          source: "acquired",
          attempts,
          reason: `Acquired approved external MCP ${acquired.capability.name} at revision ${acquired.capability.revision}`,
          evidence: {
            provenanceSource: "external",
            sourceType: acquired.receipt.sourceType,
            sourceUri: acquired.receipt.sourceUri,
            resolvedRevision: acquired.receipt.resolvedRevision,
            contentHash: acquired.receipt.contentHash,
            acquisitionReceiptId: acquired.receipt.id,
            acquisitionStatus: acquired.receipt.status,
            candidateId: acquired.receipt.candidateId,
            securityRisk: acquired.receipt.security.overall
          }
        };
      } catch (error) {
        attempts.push({
          candidateId: rankedCandidate.candidate.id,
          candidateName: rankedCandidate.candidate.name,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }
    return {
      status: "acquisition_failed",
      source: "none",
      attempts,
      reason: attempts.map(attempt => `${attempt.candidateName}: ${attempt.reason ?? "failed"}`).join(" | ")
    };
  }

  private mcpAllowed(need: CapabilityNeed): boolean {
    const kinds = need.policy?.acceptableKinds;
    return !kinds || kinds.length === 0 || kinds.includes("mcp");
  }
}

export function parseExternalMcpCatalogJson(value: string | undefined): ExternalMcpCatalogEntry[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`MISSION_EXTERNAL_MCP_CATALOG_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("MISSION_EXTERNAL_MCP_CATALOG_JSON must be a JSON array");
  const entries = parsed.map((value, index) => parseEntry(value, index));
  void new ExternalMcpCatalog(entries);
  return entries;
}

function normalizeEntry(entry: ExternalMcpCatalogEntry): NormalizedExternalMcpEntry {
  const id = bounded(entry.id, "External MCP id", 96);
  if (!CATALOG_ID.test(id)) throw new Error(`External MCP id must match ${CATALOG_ID}: ${id}`);
  const name = bounded(entry.name, `External MCP ${id} name`, 32);
  if (!SERVER_NAME.test(name)) throw new Error(`External MCP ${id} name must match ${SERVER_NAME}`);
  const description = bounded(entry.description, `External MCP ${id} description`, MAX_TEXT);
  const revision = bounded(entry.revision, `External MCP ${id} revision`, 160);
  if (!SAFE_REVISION.test(revision) || revision.includes("..")) throw new Error(`External MCP ${id} revision is unsafe`);
  const url = normalizeHttpsUrl(entry.url, id);
  const functions = stringList(entry.functions, `External MCP ${id} functions`, true);
  const accepts = stringList(entry.accepts ?? [], `External MCP ${id} accepts`, false);
  const produces = stringList(entry.produces ?? [], `External MCP ${id} produces`, false);
  const manifest = { id, name, description, revision, url, functions, accepts, produces };
  const contentHash = `sha256:${createHash("sha256").update(stableJson(manifest)).digest("hex")}`;
  return {
    id,
    name,
    description,
    revision,
    url,
    functions,
    ...(accepts.length ? { accepts } : {}),
    ...(produces.length ? { produces } : {}),
    contentHash,
    candidateId: `mcp-registry:${id}`,
    capabilityId: `${EXTERNAL_CAPABILITY_PREFIX}${id}`
  };
}

function candidateFromEntry(entry: NormalizedExternalMcpEntry): CapabilityCandidate {
  return {
    id: entry.candidateId,
    sourceType: "mcp-registry",
    sourceUri: sourceUri(entry),
    name: entry.name,
    description: `${entry.description} ${entry.functions.join(" ")}`,
    candidateKind: "mcp",
    resolvedRevision: entry.revision,
    contentHash: entry.contentHash,
    status: "discovered"
  };
}

function capabilityFromEntry(entry: NormalizedExternalMcpEntry): CapabilityDescriptor {
  return {
    id: entry.capabilityId,
    kind: "mcp",
    name: entry.name,
    description: entry.description,
    hostNative: false,
    available: true,
    invocationRef: entry.url,
    permissions: ["network-read", "external-mcp-tools"],
    revision: entry.revision,
    scope: "mission",
    functions: [...entry.functions],
    ...(entry.accepts?.length ? { accepts: [...entry.accepts] } : {}),
    ...(entry.produces?.length ? { produces: [...entry.produces] } : {}),
    constraints: { supportedPurposes: ["production", "verification", "research", "integration"] },
    routing: { executionMode: "host-agent", resumable: true, concurrent: true, isolation: "remote" },
    cost: { monetaryClass: "unknown", latencyClass: "remote", metered: true },
    native: {
      provider: "external-mcp",
      nativeId: entry.name,
      protocol: "mcp-streamable-http",
      loadMode: "mission-overlay",
      features: ["remote-https", "no-credentials", "explicit-acquisition-approval"]
    },
    provenance: {
      source: "external",
      sourceRef: sourceUri(entry),
      revision: entry.revision,
      contentHash: entry.contentHash
    }
  };
}

function deliveryEntryFromCapability(capability: CapabilityDescriptor): MissionMcpEntry | undefined {
  if (capability.kind !== "mcp" || capability.hostNative || !capability.available) return undefined;
  if (!capability.id.startsWith(EXTERNAL_CAPABILITY_PREFIX)) return undefined;
  if (capability.native?.provider !== "external-mcp" || capability.native.protocol !== "mcp-streamable-http") {
    throw new Error(`External MCP capability ${capability.id} has unsupported native identity`);
  }
  if (!capability.native.features?.includes("no-credentials")) {
    throw new Error(`External MCP capability ${capability.id} is missing no-credentials trust marker`);
  }
  const name = capability.native.nativeId?.trim();
  if (!name || !SERVER_NAME.test(name)) throw new Error(`External MCP capability ${capability.id} has invalid server name`);
  if (!capability.invocationRef) throw new Error(`External MCP capability ${capability.id} is missing endpoint`);
  const url = normalizeHttpsUrl(capability.invocationRef, capability.id);
  return {
    capability: structuredClone(capability),
    server: { transport: "http", name, url, headers: [] }
  };
}

function withMissionMcp<T extends AgentCreateRequest | AgentResumeRequest>(request: T, registry: MissionExternalMcpRegistry): T {
  const acquired = registry.select(request.missionId, request.allowedCapabilityRefs);
  if (acquired.length === 0) return request;
  const existing = request.mcpServers ?? [];
  const names = new Set(existing.map(server => server.name));
  for (const server of acquired) {
    if (names.has(server.name)) throw new Error(`Mission MCP server name collides with trusted MCP: ${server.name}`);
    names.add(server.name);
  }
  return { ...request, mcpServers: [...existing.map(cloneServer), ...acquired] };
}

function securityAssessment(entry: NormalizedExternalMcpEntry): SecurityAssessment {
  return {
    candidateId: entry.candidateId,
    overall: "high",
    findings: [{
      severity: "high",
      category: "external-remote-tools",
      detail: "External MCP is an untrusted remote tool provider that can receive Mission context; Runtime does not claim semantic read-only enforcement over its advertised tools."
    }],
    requestedPermissions: ["network-read", "external-mcp-tools"],
    recommendedAction: "approval_required"
  };
}

function externalMcpPolicy(): PolicyDecision {
  return {
    action: "require_approval",
    reason: "Every external MCP requires explicit per-Mission approval because remote tool semantics are not trusted by catalog metadata alone.",
    constraints: ["mission-local", "https-only", "no-credentials", "no-local-code-execution", "one-shot-user-approval"]
  };
}

function makeReceipt(
  entry: NormalizedExternalMcpEntry,
  candidate: CapabilityCandidate,
  need: CapabilityNeed,
  security: SecurityAssessment,
  policy: PolicyDecision,
  status: "rejected" | "approval_rejected" | "activated",
  reason?: string,
  approval?: { approved: boolean; actor?: string; decidedAt: string },
  activatedCapability?: CapabilityDescriptor
) {
  return {
    id: `acquisition:${randomUUID()}`,
    missionId: need.missionId,
    capabilityNeedId: need.id,
    candidateId: candidate.id,
    sourceType: "mcp-registry",
    sourceUri: sourceUri(entry),
    resolvedRevision: entry.revision,
    contentHash: entry.contentHash,
    allowedRisk: need.maxRisk,
    security,
    policy,
    ...(approval ? { approval } : {}),
    ...(activatedCapability ? { activatedCapability } : {}),
    status,
    ...(reason ? { reason } : {}),
    createdAt: new Date().toISOString()
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
    ...(object.accepts === undefined ? {} : { accepts: requiredStringArray(object.accepts, `externalMcpCatalog[${index}].accepts`) }),
    ...(object.produces === undefined ? {} : { produces: requiredStringArray(object.produces, `externalMcpCatalog[${index}].produces`) })
  };
}

function normalizeHttpsUrl(value: string, id: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`External MCP ${id} requires HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`External MCP ${id} URL must not contain credentials, query parameters or fragments`);
  }
  return url.toString();
}

function sourceUri(entry: Pick<NormalizedExternalMcpEntry, "id" | "revision">): string {
  return `mcp-registry:${entry.id}@${entry.revision}`;
}

function stringList(values: string[], label: string, required: boolean): string[] {
  if (!Array.isArray(values) || (required && values.length === 0) || values.length > 64) {
    throw new Error(`${label} must contain ${required ? "1-64" : "0-64"} strings`);
  }
  const result = [...new Set(values.map((value, index) => bounded(value, `${label}[${index}]`, 256)))];
  if (required && result.length === 0) throw new Error(`${label} must not be empty`);
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
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${label} must be a string array`);
  return [...value] as string[];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function cloneServer(server: HostMcpServer): HostMcpServer {
  return server.transport === "stdio"
    ? { transport: "stdio", name: server.name, command: server.command, args: [...server.args], env: server.env.map(item => ({ ...item })) }
    : { transport: "http", name: server.name, url: server.url, headers: server.headers.map(item => ({ ...item })) };
}
