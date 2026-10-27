import type { CapabilityCandidate, CapabilityDescriptor, CapabilityNeed, SecurityAssessment } from "../domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "./discovery-provider.ts";
import { CandidateRanker, type RankedCandidate } from "./candidate-ranker.ts";
import { PolicyEngine, type PolicyDecision } from "../policy/policy-engine.ts";

export interface CandidateInspection {
  candidate: CapabilityCandidate;
  security: SecurityAssessment;
  policy: PolicyDecision;
}

export interface CandidateInspector {
  inspect(candidate: CapabilityCandidate): Promise<SecurityAssessment>;
}

export interface CandidateActivator {
  activate(candidate: CapabilityCandidate, need: CapabilityNeed): Promise<CapabilityDescriptor>;
}

export class AcquisitionService {
  private readonly providers: CapabilityDiscoveryProvider[];
  private readonly ranker: CandidateRanker;
  private readonly policy: PolicyEngine;
  private readonly inspector: CandidateInspector;
  private readonly activator: CandidateActivator;

  constructor(options: {
    providers: CapabilityDiscoveryProvider[];
    inspector: CandidateInspector;
    activator: CandidateActivator;
    ranker?: CandidateRanker;
    policy?: PolicyEngine;
  }) {
    this.providers = options.providers;
    this.inspector = options.inspector;
    this.activator = options.activator;
    this.ranker = options.ranker ?? new CandidateRanker();
    this.policy = options.policy ?? new PolicyEngine();
  }

  async discover(need: CapabilityNeed): Promise<RankedCandidate[]> {
    const all = (await Promise.all(this.providers.map(provider => provider.discover(need)))).flat();
    const deduped = new Map<string, CapabilityCandidate>();
    for (const candidate of all) deduped.set(`${candidate.sourceType}:${candidate.sourceUri}`, candidate);
    return this.ranker.rank(need, [...deduped.values()]);
  }

  async inspect(candidate: CapabilityCandidate): Promise<CandidateInspection> {
    const security = await this.inspector.inspect(candidate);
    return { candidate, security, policy: this.policy.evaluateSecurity(security) };
  }

  async activate(inspection: CandidateInspection, need: CapabilityNeed): Promise<CapabilityDescriptor> {
    if (inspection.policy.action === "deny") throw new Error(`Candidate denied: ${inspection.policy.reason}`);
    if (inspection.policy.action === "require_approval") throw new Error("Approval required before capability activation");
    return this.activator.activate(inspection.candidate, need);
  }
}
