import type { CapabilityDescriptor, CapabilityNeed, CapabilityProvenance, RiskLevel } from "../domain/capability.ts";
import type { RankedCandidate } from "./candidate-ranker.ts";
import { buildHostCapabilityGraph, type HostCapabilityGraphSource } from "./capability-graph.ts";
import { CapabilityResolver } from "./resolver.ts";
import { MissionCapabilityOverlay } from "./mission-capability-overlay.ts";
import type { CapabilityAcquisitionOutcome } from "./acquisition-transaction.ts";

export interface CapabilityCandidateDiscovery {
  discover(need: CapabilityNeed): Promise<RankedCandidate[]>;
}

export interface CapabilityAcquirer {
  acquire(candidate: RankedCandidate["candidate"], need: CapabilityNeed): Promise<CapabilityAcquisitionOutcome>;
}

export interface HostCapabilitySource {
  listHostCapabilities(): Promise<CapabilityDescriptor[]>;
  /** Preferred production path: preserves host environment/routing semantics for graph resolution. */
  snapshotHostCapabilities?(): Promise<HostCapabilityGraphSource>;
}

export interface CapabilityEnsureAttempt {
  candidateId: string;
  candidateName: string;
  ok: boolean;
  reason?: string;
}

export interface CapabilityResolutionEvidence {
  provenanceSource: CapabilityProvenance["source"] | "unknown";
  sourceType?: string;
  sourceUri?: string;
  resolvedRevision?: string;
  contentHash?: string;
  acquisitionReceiptId?: string;
  acquisitionStatus?: string;
  candidateId?: string;
  securityRisk?: RiskLevel;
  cacheKey?: string;
}

export interface CapabilityEnsureResult {
  status: "resolved" | "missing" | "acquisition_failed";
  capability?: CapabilityDescriptor;
  source: "host-or-overlay" | "acquired" | "trusted-cache" | "none";
  attempts: CapabilityEnsureAttempt[];
  reason: string;
  evidence?: CapabilityResolutionEvidence;
}

export interface CapabilityRuntime {
  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void;
  deactivateMissionCapability(missionId: string, capabilityId: string): void;
  ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult>;
}

export class CapabilityCoordinator implements CapabilityRuntime {
  private readonly hostCapabilities: HostCapabilitySource;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly discovery: CapabilityCandidateDiscovery;
  private readonly acquirer: CapabilityAcquirer;
  private readonly resolver: CapabilityResolver;
  private readonly maxCandidates: number;

  constructor(options: {
    hostCapabilities: HostCapabilitySource;
    overlay: MissionCapabilityOverlay;
    discovery: CapabilityCandidateDiscovery;
    acquirer: CapabilityAcquirer;
    resolver?: CapabilityResolver;
    maxCandidates?: number;
  }) {
    this.hostCapabilities = options.hostCapabilities;
    this.overlay = options.overlay;
    this.discovery = options.discovery;
    this.acquirer = options.acquirer;
    this.resolver = options.resolver ?? new CapabilityResolver();
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 3);
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    for (const capability of capabilities) {
      if (capability.hostNative || !capability.available) continue;
      this.overlay.activate(missionId, capability);
    }
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.overlay.deactivate(missionId, capabilityId);
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    const existing = await this.resolveExisting(need);
    if (existing.status === "resolved" && existing.capability) {
      const capability = existing.capability;
      const provenance = capability.provenance;
      return {
        status: "resolved",
        capability,
        source: "host-or-overlay",
        attempts: [],
        reason: existing.reason,
        evidence: {
          provenanceSource: provenance?.source
            ?? (capability.hostNative ? "host" : capability.scope === "trusted-cache" ? "trusted-cache" : "mission"),
          ...(capability.hostNative ? { sourceType: "host" } : {}),
          ...(provenance?.sourceRef ? { sourceUri: provenance.sourceRef } : {}),
          ...(provenance?.revision ? { resolvedRevision: provenance.revision } : capability.revision ? { resolvedRevision: capability.revision } : {}),
          ...(provenance?.contentHash ? { contentHash: provenance.contentHash } : {})
        }
      };
    }

    if (!need.acquisitionAllowed) {
      return {
        status: "missing",
        source: "none",
        attempts: [],
        reason: `${existing.reason}; acquisition is disabled for this need`
      };
    }

    const ranked = await this.discovery.discover(need);
    if (ranked.length === 0) {
      return {
        status: "missing",
        source: "none",
        attempts: [],
        reason: `${existing.reason}; no external candidates discovered`
      };
    }

    const attempts: CapabilityEnsureAttempt[] = [];
    for (const rankedCandidate of ranked.slice(0, this.maxCandidates)) {
      try {
        const acquired = await this.acquirer.acquire(rankedCandidate.candidate, need);
        attempts.push({
          candidateId: rankedCandidate.candidate.id,
          candidateName: rankedCandidate.candidate.name,
          ok: true
        });
        const cacheReused = acquired.receipt.status === "activated_from_trusted_cache"
          || acquired.receipt.cache?.status === "reused";
        return {
          status: "resolved",
          capability: acquired.capability,
          source: cacheReused ? "trusted-cache" : "acquired",
          attempts,
          reason: cacheReused
            ? `Reused trusted byte-identical ${acquired.capability.name} at revision ${acquired.capability.revision ?? "unknown"}`
            : `Acquired ${acquired.capability.name} at revision ${acquired.capability.revision ?? "unknown"}`,
          evidence: {
            provenanceSource: acquired.capability.provenance?.source ?? (cacheReused ? "trusted-cache" : "external"),
            sourceType: acquired.receipt.sourceType,
            sourceUri: acquired.receipt.sourceUri,
            resolvedRevision: acquired.receipt.resolvedRevision,
            contentHash: acquired.receipt.contentHash,
            acquisitionReceiptId: acquired.receipt.id,
            acquisitionStatus: acquired.receipt.status,
            candidateId: acquired.receipt.candidateId,
            securityRisk: acquired.receipt.security.overall,
            ...(acquired.receipt.cache?.cacheKey ? { cacheKey: acquired.receipt.cache.cacheKey } : {})
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
      reason: attempts.map(item => `${item.candidateName}: ${item.reason ?? "failed"}`).join(" | ")
    };
  }

  private async resolveExisting(need: CapabilityNeed) {
    if (this.hostCapabilities.snapshotHostCapabilities) {
      const snapshot = await this.hostCapabilities.snapshotHostCapabilities();
      const effective = this.overlay.effective(need.missionId, snapshot.capabilities);
      return this.resolver.resolve(need, buildHostCapabilityGraph({ ...snapshot, capabilities: effective }));
    }
    const host = await this.hostCapabilities.listHostCapabilities();
    const effective = this.overlay.effective(need.missionId, host);
    return this.resolver.resolve(need, effective);
  }
}
