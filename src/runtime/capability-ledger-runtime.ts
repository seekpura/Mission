import { createHash, randomUUID } from "node:crypto";
import type {
  CapabilityDescriptor,
  CapabilityNeed
} from "../core/domain/capability.ts";
import type {
  CapabilityAuditDecision,
  CapabilityAuditRecord,
  CapabilityCostRecord,
  CapabilitySourceIdentity,
  CapabilityTrustLevel,
  CapabilityTrustRecord
} from "../core/domain/capability-ledger.ts";
import type {
  CapabilityEnsureResult,
  CapabilityResolutionEvidence,
  CapabilityRuntime
} from "../core/capabilities/capability-coordinator.ts";
import type { MissionEvent, MissionEventType } from "../core/domain/event.ts";
import type { EventStore } from "../core/events/event-store.ts";

export interface CapabilityResolutionLedgerEnvelope {
  trust: CapabilityTrustRecord;
  cost: CapabilityCostRecord;
  audit: CapabilityAuditRecord;
}

/**
 * Runtime-owned durable audit boundary around capability resolution. The
 * underlying resolver/acquirer decides what can satisfy the need; this wrapper
 * makes trust, declared cost and audit evidence durable before the controller
 * is allowed to use the capability for a Work attempt.
 *
 * Successful resolution is written as one atomic Event envelope. SQLite then
 * projects trust/cost/audit rows in the same transaction as that Event, so a
 * crash cannot leave a half-written capability ledger.
 */
export class CapabilityLedgerRuntime implements CapabilityRuntime {
  private readonly base: CapabilityRuntime;
  private readonly events: EventStore;

  constructor(base: CapabilityRuntime, events: EventStore) {
    this.base = base;
    this.events = events;
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    this.base.restoreMissionCapabilities(missionId, capabilities);
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.base.deactivateMissionCapability(missionId, capabilityId);
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    let result: CapabilityEnsureResult;
    try {
      result = await this.base.ensure(need);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.recordRejected(need, {
        status: "acquisition_failed",
        source: "none",
        attempts: [],
        reason
      });
      throw error;
    }

    if (result.status !== "resolved" || !result.capability) {
      await this.recordRejected(need, result);
      return result;
    }

    try {
      await this.recordResolved(need, result);
      return result;
    } catch (error) {
      this.base.deactivateMissionCapability(need.missionId, result.capability.id);
      const reason = `Capability ledger commit failed; capability was deactivated before Work execution: ${error instanceof Error ? error.message : String(error)}`;
      return {
        status: "acquisition_failed",
        source: "none",
        attempts: [...result.attempts, {
          candidateId: result.evidence?.candidateId ?? result.capability.id,
          candidateName: result.capability.name,
          ok: false,
          reason
        }],
        reason
      };
    }
  }

  private async recordResolved(need: CapabilityNeed, result: CapabilityEnsureResult): Promise<void> {
    const capability = result.capability!;
    const at = new Date().toISOString();
    const evidence = result.evidence;
    const token = ledgerToken(need, capability, result.source, evidence);
    const trust = trustRecord(need, capability, result, token, at);
    const cost = costRecord(need, capability, result, token, at);
    const audit = auditRecord(need, capability, result, token, at, trust.id, cost.id);
    const envelope: CapabilityResolutionLedgerEnvelope = { trust, cost, audit };

    await this.append(
      need.missionId,
      "capability.resolution.recorded",
      envelope,
      `capability-resolution:${token}`
    );
  }

  private async recordRejected(need: CapabilityNeed, result: CapabilityEnsureResult): Promise<void> {
    const at = new Date().toISOString();
    const token = createHash("sha256").update(stableJson({
      missionId: need.missionId,
      needId: need.id,
      status: result.status,
      reason: result.reason,
      attempts: result.attempts
    })).digest("hex");
    const audit: CapabilityAuditRecord = {
      id: `capability-audit:${token.slice(0, 32)}`,
      missionId: need.missionId,
      capabilityNeedId: need.id,
      decision: "rejected",
      resolutionSource: "none",
      reason: result.reason,
      attempts: result.attempts.map(attempt => ({ ...attempt })),
      recordedAt: at
    };
    await this.append(
      need.missionId,
      "capability.audit.recorded",
      audit,
      `capability-audit-rejected:${token}`
    );
  }

  private async append(
    missionId: string,
    type: Extract<MissionEventType,
      | "capability.resolution.recorded"
      | "capability.audit.recorded">,
    payload: unknown,
    idempotencyKey: string
  ): Promise<MissionEvent> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const expected = await this.events.lastSequence(missionId);
      try {
        return await this.events.append({
          id: randomUUID(),
          missionId,
          type,
          actor: { type: "system", id: "runtime-capability-ledger" },
          payload,
          idempotencyKey,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        }, expected);
      } catch (error) {
        if (attempt === 4 || !(error instanceof Error) || !error.name.includes("Concurrency")) throw error;
      }
    }
    throw new Error("Unreachable capability ledger append retry state");
  }
}

export class RuntimeCapabilityLifecycleManager {
  private readonly capabilities: CapabilityRuntime;
  private readonly events: EventStore;

  constructor(capabilities: CapabilityRuntime, events: EventStore) {
    this.capabilities = capabilities;
    this.events = events;
  }

  async deactivate(input: {
    missionId: string;
    capabilityId: string;
    reason: string;
    revoked?: boolean;
  }): Promise<void> {
    if (!input.missionId.trim() || !input.capabilityId.trim() || !input.reason.trim()) {
      throw new Error("Capability lifecycle change requires missionId, capabilityId and reason");
    }
    const type: Extract<MissionEventType, "capability.deactivated" | "capability.revoked"> = input.revoked
      ? "capability.revoked"
      : "capability.deactivated";
    const reason = input.reason.trim();
    const token = createHash("sha256").update(stableJson({
      missionId: input.missionId,
      capabilityId: input.capabilityId,
      type,
      reason
    })).digest("hex");
    const at = new Date().toISOString();
    const audit: CapabilityAuditRecord = {
      id: `capability-audit-lifecycle:${token.slice(0, 24)}`,
      missionId: input.missionId,
      capabilityId: input.capabilityId,
      decision: input.revoked ? "revoked" : "deactivated",
      resolutionSource: "none",
      reason,
      attempts: [],
      recordedAt: at
    };
    const revokedTrust: CapabilityTrustRecord | undefined = input.revoked ? {
      id: `capability-trust-revoked:${token.slice(0, 24)}`,
      missionId: input.missionId,
      capabilityNeedId: "lifecycle",
      capabilityId: input.capabilityId,
      trustLevel: "revoked",
      provenanceSource: "unknown",
      reusable: false,
      reason,
      recordedAt: at
    } : undefined;

    await appendLifecycle(this.events, input.missionId, type, {
      capabilityId: input.capabilityId,
      reason,
      changedAt: at,
      audit,
      ...(revokedTrust ? { revokedTrust } : {})
    }, `${type}:${token}`);

    // Durable state is authoritative. Only mutate the in-memory overlay after
    // the lifecycle Event and its read-model projections commit successfully.
    this.capabilities.deactivateMissionCapability(input.missionId, input.capabilityId);
  }
}

function trustRecord(
  need: CapabilityNeed,
  capability: CapabilityDescriptor,
  result: CapabilityEnsureResult,
  token: string,
  at: string
): CapabilityTrustRecord {
  const evidence = result.evidence;
  const trustLevel = trustLevelFor(capability, result.source, evidence);
  const identity = sourceIdentity(evidence);
  return {
    id: `capability-trust:${token.slice(0, 32)}`,
    missionId: need.missionId,
    capabilityNeedId: need.id,
    capabilityId: capability.id,
    trustLevel,
    provenanceSource: evidence?.provenanceSource ?? capability.provenance?.source ?? (capability.hostNative ? "host" : "unknown"),
    ...(identity ? { identity } : {}),
    ...(evidence?.securityRisk ? { securityRisk: evidence.securityRisk } : {}),
    ...(evidence?.acquisitionReceiptId ? { acquisitionReceiptId: evidence.acquisitionReceiptId } : {}),
    ...(evidence?.cacheKey ? { cacheKey: evidence.cacheKey } : {}),
    reusable: capability.hostNative || Boolean(evidence?.cacheKey),
    reason: result.reason,
    recordedAt: at
  };
}

function costRecord(
  need: CapabilityNeed,
  capability: CapabilityDescriptor,
  result: CapabilityEnsureResult,
  token: string,
  at: string
): CapabilityCostRecord {
  const declared = capability.cost;
  return {
    id: `capability-cost:${token.slice(0, 32)}`,
    missionId: need.missionId,
    capabilityNeedId: need.id,
    capabilityId: capability.id,
    phase: result.source === "acquired" || result.source === "trusted-cache" ? "acquisition" : "resolution",
    monetaryClass: declared?.monetaryClass ?? "unknown",
    latencyClass: declared?.latencyClass ?? "unknown",
    ...(declared?.metered === undefined ? {} : { metered: declared.metered }),
    source: declared ? "capability-declared" : "unknown",
    recordedAt: at
  };
}

function auditRecord(
  need: CapabilityNeed,
  capability: CapabilityDescriptor,
  result: CapabilityEnsureResult,
  token: string,
  at: string,
  trustRecordId: string,
  costRecordId: string
): CapabilityAuditRecord {
  return {
    id: `capability-audit:${token.slice(0, 32)}`,
    missionId: need.missionId,
    capabilityNeedId: need.id,
    capabilityId: capability.id,
    ...(result.evidence?.candidateId ? { candidateId: result.evidence.candidateId } : {}),
    decision: decisionFor(result.source),
    resolutionSource: result.source,
    trustRecordId,
    costRecordId,
    ...(result.evidence?.acquisitionReceiptId ? { acquisitionReceiptId: result.evidence.acquisitionReceiptId } : {}),
    ...(result.evidence?.cacheKey ? { cacheKey: result.evidence.cacheKey } : {}),
    reason: result.reason,
    attempts: result.attempts.map(attempt => ({ ...attempt })),
    recordedAt: at
  };
}

function decisionFor(source: CapabilityEnsureResult["source"]): CapabilityAuditDecision {
  if (source === "trusted-cache") return "trusted-cache-reused";
  if (source === "acquired") return "acquired";
  if (source === "host-or-overlay") return "existing-resolved";
  return "rejected";
}

function trustLevelFor(
  capability: CapabilityDescriptor,
  source: CapabilityEnsureResult["source"],
  evidence: CapabilityResolutionEvidence | undefined
): CapabilityTrustLevel {
  if (capability.hostNative) return "host-native";
  if (source === "trusted-cache" || evidence?.provenanceSource === "trusted-cache") return "trusted-cache";
  if (source === "acquired" || evidence?.provenanceSource === "external" || evidence?.provenanceSource === "mission") {
    return "mission-verified";
  }
  return "external-unverified";
}

function sourceIdentity(evidence: CapabilityResolutionEvidence | undefined): CapabilitySourceIdentity | undefined {
  if (!evidence?.sourceType || !evidence.sourceUri || !evidence.resolvedRevision || !evidence.contentHash) return undefined;
  return {
    sourceType: evidence.sourceType,
    sourceUri: evidence.sourceUri,
    resolvedRevision: evidence.resolvedRevision,
    contentHash: evidence.contentHash
  };
}

function ledgerToken(
  need: CapabilityNeed,
  capability: CapabilityDescriptor,
  source: CapabilityEnsureResult["source"],
  evidence: CapabilityResolutionEvidence | undefined
): string {
  return createHash("sha256").update(stableJson({
    missionId: need.missionId,
    needId: need.id,
    capabilityId: capability.id,
    source,
    provenance: capability.provenance ?? null,
    revision: capability.revision ?? null,
    receipt: evidence?.acquisitionReceiptId ?? null,
    cacheKey: evidence?.cacheKey ?? null
  })).digest("hex");
}

async function appendLifecycle(
  events: EventStore,
  missionId: string,
  type: Extract<MissionEventType, "capability.deactivated" | "capability.revoked">,
  payload: unknown,
  idempotencyKey: string
): Promise<MissionEvent> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const expected = await events.lastSequence(missionId);
    try {
      return await events.append({
        id: randomUUID(),
        missionId,
        type,
        actor: { type: "system", id: "runtime-capability-lifecycle" },
        payload,
        idempotencyKey,
        schemaVersion: 1,
        createdAt: new Date().toISOString()
      }, expected);
    } catch (error) {
      if (attempt === 4 || !(error instanceof Error) || !error.name.includes("Concurrency")) throw error;
    }
  }
  throw new Error("Unreachable capability lifecycle append retry state");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
