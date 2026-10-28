import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AcquisitionReceipt,
  CapabilityCandidate,
  CapabilityDescriptor,
  CapabilityNeed,
  MaterializedCapabilityCandidate,
  SandboxAssessment,
  SecurityAssessment
} from "../domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "./discovery-provider.ts";
import type { CandidateMaterializer } from "./materializer.ts";
import { CandidateRanker } from "./candidate-ranker.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import { PolicyEngine } from "../policy/policy-engine.ts";
import type { CapabilitySmokeTester } from "./sandbox/smoke-tester.ts";
import type { MissionCapabilityOverlay } from "./mission-capability-overlay.ts";

export type AcquisitionTraceType =
  | "capability.candidate.discovered"
  | "capability.candidate.materialized"
  | "capability.candidate.scanned"
  | "capability.candidate.sandboxed"
  | "capability.activated"
  | "capability.rejected"
  | "capability.acquisition.receipt";

export interface AcquisitionObserver {
  onTrace(type: AcquisitionTraceType, payload: unknown): Promise<void> | void;
  requestApproval?(input: { need: CapabilityNeed; candidate: CapabilityCandidate; security: SecurityAssessment }): Promise<boolean>;
}

export interface AcquisitionOutcome {
  capability?: CapabilityDescriptor;
  receipt: AcquisitionReceipt;
}

export class SecureAcquisitionService {
  private readonly providers: CapabilityDiscoveryProvider[];
  private readonly materializer: CandidateMaterializer;
  private readonly smoke: CapabilitySmokeTester;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly activationRoot: string;
  private readonly ranker: CandidateRanker;
  private readonly scanner: StaticSecurityScanner;
  private readonly policy: PolicyEngine;
  private readonly maxCandidates: number;

  constructor(options: {
    providers: CapabilityDiscoveryProvider[];
    materializer: CandidateMaterializer;
    smoke: CapabilitySmokeTester;
    overlay: MissionCapabilityOverlay;
    activationRoot: string;
    ranker?: CandidateRanker;
    scanner?: StaticSecurityScanner;
    policy?: PolicyEngine;
    maxCandidates?: number;
  }) {
    this.providers = options.providers;
    this.materializer = options.materializer;
    this.smoke = options.smoke;
    this.overlay = options.overlay;
    this.activationRoot = options.activationRoot;
    this.ranker = options.ranker ?? new CandidateRanker();
    this.scanner = options.scanner ?? new StaticSecurityScanner();
    this.policy = options.policy ?? new PolicyEngine();
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 3);
  }

  async acquire(need: CapabilityNeed, observer: AcquisitionObserver): Promise<AcquisitionOutcome> {
    const discovered = (await Promise.all(this.providers.map(provider => provider.discover(need)))).flat();
    const unique = new Map<string, CapabilityCandidate>();
    for (const candidate of discovered) unique.set(`${candidate.sourceType}:${candidate.sourceUri}:${candidate.name}`, candidate);
    const ranked = this.ranker.rank(need, [...unique.values()]).slice(0, this.maxCandidates);
    if (ranked.length === 0) return this.failedReceipt(need, undefined, "No capability candidates discovered", observer);

    let lastFailure = "No candidate passed acquisition";
    for (const rankedCandidate of ranked) {
      const original = rankedCandidate.candidate;
      await observer.onTrace("capability.candidate.discovered", { needId: need.id, candidate: original, score: rankedCandidate.score });
      let materialized: MaterializedCapabilityCandidate;
      try {
        materialized = await this.materializer.materialize(original);
        await observer.onTrace("capability.candidate.materialized", { needId: need.id, candidate: materialized.candidate, root: materialized.root, resolvedRevision: materialized.resolvedRevision, contentHash: materialized.contentHash });
      } catch (error) {
        lastFailure = errorMessage(error);
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: original, reason: lastFailure });
        continue;
      }

      const security = this.scanner.scan(materialized.candidate, materialized.root);
      await observer.onTrace("capability.candidate.scanned", { needId: need.id, candidateId: original.id, security });
      const decision = this.policy.evaluateSecurity(security);
      if (decision.action === "deny") {
        lastFailure = decision.reason;
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, security });
        continue;
      }
      if (decision.action === "require_approval") {
        const approved = await observer.requestApproval?.({ need, candidate: materialized.candidate, security }) ?? false;
        if (!approved) {
          const receipt = receiptFor(need, materialized, security, { candidateId: original.id, passed: false, mode: "generic", observations: [], error: "Approval required" }, "approval_required");
          await observer.onTrace("capability.acquisition.receipt", { receipt });
          return { receipt };
        }
      }
      if (riskRank(security.overall) > riskRank(need.maxRisk)) {
        lastFailure = `Candidate risk ${security.overall} exceeds need maxRisk ${need.maxRisk}`;
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, security });
        continue;
      }

      const sandbox = await this.smoke.test(materialized);
      await observer.onTrace("capability.candidate.sandboxed", { needId: need.id, candidateId: original.id, sandbox });
      if (!sandbox.passed || !sandbox.invocationRef) {
        lastFailure = sandbox.error ?? "Capability smoke test failed";
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, sandbox });
        continue;
      }

      const capability = this.activate(need, materialized, sandbox);
      const receipt = receiptFor(need, materialized, security, sandbox, "activated", capability.id);
      await observer.onTrace("capability.activated", { needId: need.id, capability, candidate: materialized.candidate });
      await observer.onTrace("capability.acquisition.receipt", { receipt });
      return { capability, receipt };
    }
    return this.failedReceipt(need, ranked[0]?.candidate, lastFailure, observer);
  }

  private activate(need: CapabilityNeed, materialized: MaterializedCapabilityCandidate, sandbox: SandboxAssessment): CapabilityDescriptor {
    const capabilityId = `mission-capability:${need.id}:${materialized.resolvedRevision.slice(0, 12)}`;
    const destination = join(this.activationRoot, need.missionId, safeName(capabilityId));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(materialized.root, destination, { recursive: true, dereference: false });
    const relativeInvocation = relativeToRoot(materialized.root, sandbox.invocationRef!);
    const invocationRef = join(destination, relativeInvocation);
    const capability: CapabilityDescriptor = {
      id: capabilityId,
      kind: materialized.candidate.candidateKind,
      name: materialized.candidate.name,
      description: materialized.candidate.description ?? need.objective,
      hostNative: false,
      available: true,
      invocationRef,
      permissions: [],
      revision: materialized.resolvedRevision,
      contentHash: materialized.contentHash,
      sourceUri: materialized.candidate.sourceUri,
      scope: "mission",
      metadata: { acquisitionNeedId: need.id, smokeMode: sandbox.mode }
    };
    this.overlay.activate(need.missionId, capability);
    return capability;
  }

  private async failedReceipt(need: CapabilityNeed, candidate: CapabilityCandidate | undefined, reason: string, observer: AcquisitionObserver): Promise<AcquisitionOutcome> {
    const receipt: AcquisitionReceipt = {
      id: randomUUID(),
      missionId: need.missionId,
      capabilityNeedRef: need.id,
      candidateId: candidate?.id ?? "none",
      sourceUri: candidate?.sourceUri ?? "",
      resolvedRevision: candidate?.resolvedRevision ?? "",
      contentHash: candidate?.contentHash ?? "",
      security: { candidateId: candidate?.id ?? "none", overall: "blocked", findings: [{ severity: "blocked", category: "acquisition", detail: reason }], requestedPermissions: [], recommendedAction: "reject" },
      sandbox: { candidateId: candidate?.id ?? "none", passed: false, mode: "generic", observations: [], error: reason },
      status: "failed",
      createdAt: new Date().toISOString()
    };
    await observer.onTrace("capability.acquisition.receipt", { receipt });
    return { receipt };
  }
}

function receiptFor(need: CapabilityNeed, materialized: MaterializedCapabilityCandidate, security: SecurityAssessment, sandbox: SandboxAssessment, status: AcquisitionReceipt["status"], capabilityRef?: string): AcquisitionReceipt {
  return {
    id: randomUUID(), missionId: need.missionId, capabilityNeedRef: need.id, candidateId: materialized.candidate.id,
    sourceUri: materialized.candidate.sourceUri, resolvedRevision: materialized.resolvedRevision, contentHash: materialized.contentHash,
    security, sandbox, capabilityRef, status, createdAt: new Date().toISOString()
  };
}
function safeName(value: string) { return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function relativeToRoot(root: string, path: string) { return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : basename(path); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function riskRank(value: "low" | "medium" | "high" | "blocked") { return ({ low: 0, medium: 1, high: 2, blocked: 3 } as const)[value]; }
