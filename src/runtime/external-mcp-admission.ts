import type {
  CapabilityDescriptor,
  CapabilityNeed,
  RiskLevel
} from "../core/domain/capability.ts";
import type {
  CapabilityEnsureAttempt,
  CapabilityEnsureResult,
  CapabilityRuntime
} from "../core/capabilities/capability-coordinator.ts";
import { CandidateRanker } from "../core/capabilities/candidate-ranker.ts";
import { CapabilityResolver } from "../core/capabilities/resolver.ts";
import type { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
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
import type { IdempotentAcquisitionApprovalBroker } from "./approval-manager.ts";
import {
  ExternalMcpCatalogDiscoveryProvider,
  type ResolvedExternalMcpCatalogEntry
} from "./external-mcp-catalog.ts";

const EXTERNAL_MCP_PREFIX = "external-mcp:";
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const EXTERNAL_MCP_RISK: RiskLevel = "high";
const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, blocked: 3 };

export interface CapabilityRevocationReader {
  isCapabilityRevoked(missionId: string, capabilityId: string): boolean;
}

/**
 * Projects only already-restored Mission-local external MCP descriptors into
 * Host MCP declarations. MissionCapabilityOverlay is a transient projection of
 * durable capability.activated history; approval by itself never populates it.
 *
 * Production places TrustedMcpHostAdapter outside this adapter. That outer
 * boundary rejects caller-supplied mcpServers before trusted and Mission-local
 * declarations are merged here and passed to provider-native delivery.
 */
export class MissionExternalMcpHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly overlay: MissionCapabilityOverlay;

  constructor(base: HostAdapter, overlay: MissionCapabilityOverlay) {
    this.base = base;
    this.overlay = overlay;
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return this.base.snapshotEnvironment();
  }

  createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    return this.base.createAgent(withMissionMcp(request, this.overlay));
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    try {
      return await this.base.resumeAgent(withMissionMcp(request, this.overlay));
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  cancelAgent(handle: HostAgentHandle): Promise<void> {
    return this.base.cancelAgent(handle);
  }

  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    return this.base.observeAgent(handle);
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }
}

/**
 * External MCP acquisition boundary.
 *
 * The Runtime does not mutate Mission activation state here. A successful
 * ensure returns an approved immutable descriptor to MissionController; only
 * the controller's durable capability.activated Event makes it restorable and
 * deliverable. This keeps the crash window after approval fail-closed while the
 * stable approval idempotency key lets a retry reuse the durable decision.
 *
 * A durable capability.revoked lifecycle decision is a tombstone for that
 * Mission-local external MCP capability id. Admission checks it before asking
 * for or reusing approval, so an old approval can never silently reacquire a
 * revoked external identity.
 */
export class ExternalMcpAdmissionRuntime implements CapabilityRuntime {
  private readonly base: CapabilityRuntime;
  private readonly catalog: ExternalMcpCatalogDiscoveryProvider;
  private readonly approvals: IdempotentAcquisitionApprovalBroker;
  private readonly revocations: CapabilityRevocationReader;
  private readonly ranker: CandidateRanker;
  private readonly resolver = new CapabilityResolver();
  private readonly maxCandidates: number;

  constructor(options: {
    base: CapabilityRuntime;
    catalog: ExternalMcpCatalogDiscoveryProvider;
    approvals: IdempotentAcquisitionApprovalBroker;
    revocations: CapabilityRevocationReader;
    ranker?: CandidateRanker;
    maxCandidates?: number;
  }) {
    this.base = options.base;
    this.catalog = options.catalog;
    this.approvals = options.approvals;
    this.revocations = options.revocations;
    this.ranker = options.ranker ?? new CandidateRanker();
    this.maxCandidates = Math.max(1, Math.min(10, options.maxCandidates ?? 3));
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    this.base.restoreMissionCapabilities(missionId, capabilities);
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.base.deactivateMissionCapability(missionId, capabilityId);
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    const base = await this.base.ensure(need);
    if (base.status === "resolved" && base.capability) return base;
    if (!need.acquisitionAllowed) return base;
    const acceptableKinds = need.policy?.acceptableKinds;
    if (acceptableKinds && acceptableKinds.length > 0 && !acceptableKinds.includes("mcp")) return base;

    const candidates = this.ranker.rank(need, await this.catalog.discover(need));
    if (candidates.length === 0) return base;

    const attempts: CapabilityEnsureAttempt[] = [...base.attempts];
    for (const ranked of candidates.slice(0, this.maxCandidates)) {
      let entry: ResolvedExternalMcpCatalogEntry;
      try {
        entry = this.catalog.resolveCandidate(ranked.candidate);
      } catch (error) {
        attempts.push({
          candidateId: ranked.candidate.id,
          candidateName: ranked.candidate.name,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        });
        continue;
      }

      const capabilityId = externalCapabilityId(entry);
      if (this.revocations.isCapabilityRevoked(need.missionId, capabilityId)) {
        attempts.push({
          candidateId: entry.candidateId,
          candidateName: entry.name,
          ok: false,
          reason: `External MCP capability ${capabilityId} is durably revoked for Mission ${need.missionId}`
        });
        continue;
      }

      if (RISK_RANK[EXTERNAL_MCP_RISK] > RISK_RANK[need.maxRisk]) {
        attempts.push({
          candidateId: entry.candidateId,
          candidateName: entry.name,
          ok: false,
          reason: `External MCP requires high-risk admission, but need ${need.id} allows ${need.maxRisk}`
        });
        continue;
      }

      const capability = capabilityFromEntry(entry);
      const eligibility = this.resolver.resolve(need, [capability]);
      if (eligibility.status !== "resolved") {
        attempts.push({
          candidateId: entry.candidateId,
          candidateName: entry.name,
          ok: false,
          reason: eligibility.reason
        });
        continue;
      }

      try {
        const approval = await this.approvals.requestApproval({
          missionId: need.missionId,
          candidateId: entry.candidateId,
          capabilityNeedId: need.id,
          title: `Approve external MCP: ${entry.name}`,
          reason: "External remote MCP tools can receive Mission context and require explicit per-Mission approval.",
          details: {
            sourceType: "mcp-registry",
            sourceUri: entry.sourceUri,
            registryId: entry.id,
            serverName: entry.name,
            endpointOrigin: new URL(entry.url).origin,
            resolvedRevision: entry.revision,
            contentHash: entry.contentHash,
            functions: [...entry.functions],
            credentials: "none",
            transport: "streamable-http-https"
          },
          idempotencyKey: approvalKey(need, entry)
        });
        if (!approval.approved) {
          attempts.push({
            candidateId: entry.candidateId,
            candidateName: entry.name,
            ok: false,
            reason: "User rejected external MCP activation"
          });
          continue;
        }

        attempts.push({ candidateId: entry.candidateId, candidateName: entry.name, ok: true });
        return {
          status: "resolved",
          capability,
          source: "acquired",
          attempts,
          reason: `Approved external MCP ${entry.name} at immutable revision ${entry.revision}; awaiting durable capability activation`,
          evidence: {
            provenanceSource: "external",
            sourceType: "mcp-registry",
            sourceUri: entry.sourceUri,
            resolvedRevision: entry.revision,
            contentHash: entry.contentHash,
            candidateId: entry.candidateId,
            securityRisk: EXTERNAL_MCP_RISK
          }
        };
      } catch (error) {
        attempts.push({
          candidateId: entry.candidateId,
          candidateName: entry.name,
          ok: false,
          reason: error instanceof Error ? error.message : String(error)
        });
      }
    }

    return {
      status: "acquisition_failed",
      source: "none",
      attempts,
      reason: attempts.length > 0
        ? attempts.map(attempt => `${attempt.candidateName}: ${attempt.reason ?? (attempt.ok ? "approved" : "failed")}`).join(" | ")
        : "External MCP acquisition failed without a candidate attempt"
    };
  }
}

function externalCapabilityId(entry: ResolvedExternalMcpCatalogEntry): string {
  return `${EXTERNAL_MCP_PREFIX}${entry.id}`;
}

function capabilityFromEntry(entry: ResolvedExternalMcpCatalogEntry): CapabilityDescriptor {
  return {
    id: externalCapabilityId(entry),
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
    ...(entry.accepts.length > 0 ? { accepts: [...entry.accepts] } : {}),
    ...(entry.produces.length > 0 ? { produces: [...entry.produces] } : {}),
    constraints: { supportedPurposes: ["production", "verification", "research", "integration"] },
    routing: {
      executionMode: "host-agent",
      resumable: true,
      concurrent: true,
      isolation: "remote"
    },
    cost: { monetaryClass: "unknown", latencyClass: "remote", metered: true },
    native: {
      provider: "external-mcp",
      nativeId: entry.name,
      protocol: "mcp-streamable-http",
      loadMode: "mission-overlay",
      approvalModes: ["once"],
      features: ["remote-https", "no-credentials", "explicit-acquisition-approval", "provider-native-mcp-config"],
      persistence: ["session", "resume", "recovery", "durable-state"]
    },
    provenance: {
      source: "external",
      sourceRef: entry.sourceUri,
      revision: entry.revision,
      contentHash: entry.contentHash
    }
  };
}

function deliveryServer(capability: CapabilityDescriptor): HostMcpServer | undefined {
  if (!capability.id.startsWith(EXTERNAL_MCP_PREFIX)) return undefined;
  if (capability.kind !== "mcp" || capability.hostNative || !capability.available || capability.scope !== "mission") {
    throw new Error(`External MCP capability ${capability.id} has invalid durable descriptor shape`);
  }
  if (capability.native?.provider !== "external-mcp" || capability.native.protocol !== "mcp-streamable-http") {
    throw new Error(`External MCP capability ${capability.id} has unsupported native identity`);
  }
  if (!capability.native.features?.includes("no-credentials")) {
    throw new Error(`External MCP capability ${capability.id} is missing no-credentials trust marker`);
  }
  if (capability.provenance?.source !== "external" || !capability.provenance.contentHash) {
    throw new Error(`External MCP capability ${capability.id} is missing immutable external provenance`);
  }
  const name = capability.native.nativeId?.trim();
  if (!name || !SERVER_NAME.test(name)) {
    throw new Error(`External MCP capability ${capability.id} has invalid server name`);
  }
  if (!capability.invocationRef) throw new Error(`External MCP capability ${capability.id} is missing endpoint`);
  return {
    transport: "http",
    name,
    url: normalizeDeliveryUrl(capability.invocationRef, capability.id),
    headers: []
  };
}

function withMissionMcp<T extends AgentCreateRequest | AgentResumeRequest>(
  request: T,
  overlay: MissionCapabilityOverlay
): T {
  const capabilities = new Map(overlay.list(request.missionId).map(capability => [capability.id, capability]));
  const external: HostMcpServer[] = [];
  const seenRefs = new Set<string>();
  for (const ref of request.allowedCapabilityRefs) {
    if (!ref.startsWith(EXTERNAL_MCP_PREFIX) || seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const capability = capabilities.get(ref);
    if (!capability) throw new Error(`External MCP capability ${ref} is not activated for Mission ${request.missionId}`);
    const server = deliveryServer(capability);
    if (!server) throw new Error(`External MCP capability ${ref} cannot be projected for Host delivery`);
    external.push(server);
  }
  if (external.length === 0) return request;

  const existing = (request.mcpServers ?? []).map(cloneServer);
  const names = new Set(existing.map(server => server.name));
  for (const server of external) {
    if (names.has(server.name)) throw new Error(`Mission external MCP server name collides with existing MCP: ${server.name}`);
    names.add(server.name);
    existing.push(cloneServer(server));
  }
  return { ...request, mcpServers: existing };
}

function cloneServer(server: HostMcpServer): HostMcpServer {
  return server.transport === "stdio"
    ? {
        transport: "stdio",
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(entry => ({ ...entry }))
      }
    : {
        transport: "http",
        name: server.name,
        url: server.url,
        headers: server.headers.map(entry => ({ ...entry }))
      };
}

function normalizeDeliveryUrl(value: string, capabilityId: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`External MCP capability ${capabilityId} endpoint is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`External MCP capability ${capabilityId} endpoint must be credential-free immutable HTTPS`);
  }
  return url.toString();
}

function approvalKey(need: CapabilityNeed, entry: ResolvedExternalMcpCatalogEntry): string {
  return [
    "external-mcp-admission/v1",
    need.missionId,
    need.id,
    entry.candidateId,
    entry.sourceUri,
    entry.revision,
    entry.contentHash
  ].join("\u0000");
}
