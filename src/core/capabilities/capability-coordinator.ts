import type { CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import type { RankedCandidate } from "./candidate-ranker.ts";
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
}

export interface CapabilityEnsureAttempt {
  candidateId: string;
  candidateName: string;
  ok: boolean;
  reason?: string;
}

export interface CapabilityEnsureResult {
  status: "resolved" | "missing" | "acquisition_failed";
  capability?: CapabilityDescriptor;
  source: "host-or-overlay" | "acquired" | "none";
  attempts: CapabilityEnsureAttempt[];
  reason: string;
}

export class CapabilityCoordinator {
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

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    const existing = await this.resolveExisting(need);
    if (existing.status === "resolved") {
      return {
        status: "resolved",
        capability: existing.capability,
        source: "host-or-overlay",
        attempts: [],
        reason: existing.reason
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
        return {
          status: "resolved",
          capability: acquired.capability,
          source: "acquired",
          attempts,
          reason: `Acquired ${acquired.capability.name} at revision ${acquired.capability.revision ?? "unknown"}`
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
    const host = await this.hostCapabilities.listHostCapabilities();
    const effective = this.overlay.effective(need.missionId, host);
    return this.resolver.resolve(need, effective);
  }
}
