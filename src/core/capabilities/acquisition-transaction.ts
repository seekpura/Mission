import { randomUUID } from "node:crypto";
import type {
  CapabilityCandidate,
  CapabilityDescriptor,
  CapabilityNeed,
  RiskLevel,
  SecurityAssessment
} from "../domain/capability.ts";
import type { CapabilitySourceIdentity } from "../domain/capability-ledger.ts";
import { PolicyEngine, type PolicyDecision } from "../policy/policy-engine.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import { MissionCapabilityOverlay } from "./mission-capability-overlay.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import type { MaterializedCapability, CapabilityMaterializer } from "./materialization.ts";
import type { MaterializedCapabilityActivator } from "./mission-local-directory-activator.ts";
import type { IsolatedCapabilitySmokeRunner } from "./sandbox/isolated-smoke-runner.ts";
import type {
  AcquisitionReceipt,
  AcquisitionReceiptStatus,
  AcquisitionReceiptStore
} from "./acquisition-receipt.ts";
import type { TrustedCapabilityCache, TrustedCapabilityCacheHit } from "./trusted-capability-cache.ts";

export interface AcquisitionApprovalRequest {
  missionId: string;
  candidateId: string;
  capabilityNeedId: string;
  title: string;
  reason: string;
  details: Record<string, unknown>;
}

export interface AcquisitionApprovalBroker {
  requestApproval(request: AcquisitionApprovalRequest): Promise<{
    approved: boolean;
    actor?: string;
  }>;
}

export interface CapabilityAcquisitionTransactionOptions {
  materializer: CapabilityMaterializer;
  sandboxManager: SandboxManager;
  smokeRunner: IsolatedCapabilitySmokeRunner;
  activator: MaterializedCapabilityActivator;
  overlay: MissionCapabilityOverlay;
  receiptStore: AcquisitionReceiptStore;
  trustedCache?: TrustedCapabilityCache;
  scanner?: StaticSecurityScanner;
  policy?: PolicyEngine;
  approvalBroker?: AcquisitionApprovalBroker;
}

export interface CapabilityAcquisitionOutcome {
  capability: CapabilityDescriptor;
  receipt: AcquisitionReceipt;
}

export class CapabilityAcquisitionError extends Error {
  readonly receipt?: AcquisitionReceipt;

  constructor(message: string, receipt?: AcquisitionReceipt) {
    super(message);
    this.name = "CapabilityAcquisitionError";
    this.receipt = receipt;
  }
}

/**
 * Executes the external-capability admission chain as one auditable transaction:
 * immutable materialization -> exact trusted-cache lookup OR static scan ->
 * current need/policy gate -> per-Mission approval -> isolated smoke when cache
 * evidence is unavailable -> mission-local activation -> immutable receipt ->
 * overlay. Trusted cache never reuses approval; only byte-identical validation
 * evidence and the minimal already-activated bundle are reusable.
 */
export class CapabilityAcquisitionTransaction {
  private readonly materializer: CapabilityMaterializer;
  private readonly sandboxManager: SandboxManager;
  private readonly smokeRunner: IsolatedCapabilitySmokeRunner;
  private readonly activator: MaterializedCapabilityActivator;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly receiptStore: AcquisitionReceiptStore;
  private readonly trustedCache?: TrustedCapabilityCache;
  private readonly scanner: StaticSecurityScanner;
  private readonly policy: PolicyEngine;
  private readonly approvalBroker?: AcquisitionApprovalBroker;

  constructor(options: CapabilityAcquisitionTransactionOptions) {
    this.materializer = options.materializer;
    this.sandboxManager = options.sandboxManager;
    this.smokeRunner = options.smokeRunner;
    this.activator = options.activator;
    this.overlay = options.overlay;
    this.receiptStore = options.receiptStore;
    this.trustedCache = options.trustedCache;
    this.scanner = options.scanner ?? new StaticSecurityScanner();
    this.policy = options.policy ?? new PolicyEngine();
    this.approvalBroker = options.approvalBroker;
  }

  async acquire(candidate: CapabilityCandidate, need: CapabilityNeed): Promise<CapabilityAcquisitionOutcome> {
    if (!need.acquisitionAllowed) {
      throw new CapabilityAcquisitionError(`Capability acquisition is disabled for need ${need.id}`);
    }
    if (candidate.sourceType === "host") {
      throw new CapabilityAcquisitionError("Host-native capability candidates do not require external acquisition");
    }

    let materialized: MaterializedCapability | undefined;
    let sandbox: ReturnType<SandboxManager["createFromDirectory"]> | undefined;
    try {
      materialized = await this.materializer.materialize(candidate);
      assertMaterialization(candidate, materialized);
      const pinnedCandidate: CapabilityCandidate = {
        ...candidate,
        resolvedRevision: materialized.resolvedRevision,
        contentHash: materialized.contentHash,
        status: "inspecting"
      };
      const identity = sourceIdentity(pinnedCandidate, materialized);

      let cacheHit: TrustedCapabilityCacheHit | undefined;
      let cacheLookupFailure: string | undefined;
      if (this.trustedCache) {
        try {
          cacheHit = await this.trustedCache.find(identity);
        } catch (error) {
          cacheLookupFailure = error instanceof Error ? error.message : String(error);
        }
      }

      if (cacheHit) {
        return await this.activateTrustedCache({
          candidate: pinnedCandidate,
          need,
          materialized,
          identity,
          cacheHit
        });
      }

      const security = this.scanner.scan(pinnedCandidate, materialized.root);
      const policy = this.policy.evaluateSecurity(security);
      await this.assertRiskAndPolicy({
        candidate: pinnedCandidate,
        need,
        materialized,
        security,
        policy,
        cache: cacheLookupFailure
          ? { status: "lookup_failed", reason: cacheLookupFailure }
          : { status: "miss" }
      });

      const approval = await this.requireApproval({
        candidate: pinnedCandidate,
        need,
        materialized,
        security,
        policy,
        cache: cacheLookupFailure
          ? { status: "lookup_failed", reason: cacheLookupFailure }
          : { status: "miss" }
      });

      sandbox = this.sandboxManager.createFromDirectory(materialized.root);
      let smoke: AcquisitionReceipt["smoke"];
      try {
        smoke = await this.smokeRunner.run({
          candidate: pinnedCandidate,
          need,
          sandboxRoot: sandbox.candidateRoot
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const receipt = this.receipt({
          candidate: pinnedCandidate,
          need,
          materialized,
          security,
          policy,
          approval,
          cache: cacheLookupFailure
            ? { status: "lookup_failed", reason: cacheLookupFailure }
            : { status: "miss" },
          status: "smoke_failed",
          reason: `Isolated capability smoke execution failed: ${reason}`
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(receipt.reason!, receipt);
      }

      if (!smoke.passed) {
        const receipt = this.receipt({
          candidate: pinnedCandidate,
          need,
          materialized,
          security,
          policy,
          approval,
          smoke,
          cache: cacheLookupFailure
            ? { status: "lookup_failed", reason: cacheLookupFailure }
            : { status: "miss" },
          status: "smoke_failed",
          reason: smoke.timedOut
            ? "Isolated capability smoke test timed out"
            : `Isolated capability smoke test exited ${String(smoke.exitCode)}`
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(receipt.reason!, receipt);
      }

      let capability: CapabilityDescriptor;
      try {
        capability = withProvenance(await this.activator.activate({
          candidate: { ...pinnedCandidate, status: "verified" },
          need,
          materialized,
          sandboxRoot: sandbox.candidateRoot,
          security
        }), identity, "external");
        assertActivatedCapability(capability, need, materialized);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const receipt = this.receipt({
          candidate: pinnedCandidate,
          need,
          materialized,
          security,
          policy,
          approval,
          smoke,
          cache: cacheLookupFailure
            ? { status: "lookup_failed", reason: cacheLookupFailure }
            : { status: "miss" },
          status: "activation_failed",
          reason: `Mission-local capability activation failed: ${reason}`
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(receipt.reason!, receipt);
      }

      let cache: AcquisitionReceipt["cache"] = cacheLookupFailure
        ? { status: "lookup_failed", reason: cacheLookupFailure }
        : { status: "miss" };
      if (this.trustedCache) {
        try {
          const stored = await this.trustedCache.store({
            identity,
            candidate: pinnedCandidate,
            capability,
            security,
            policy,
            smoke
          });
          cache = { status: "stored", cacheKey: stored.cacheKey };
        } catch (error) {
          cache = {
            status: "store_failed",
            reason: error instanceof Error ? error.message : String(error)
          };
        }
      }

      const receipt = this.receipt({
        candidate: pinnedCandidate,
        need,
        materialized,
        security,
        policy,
        approval,
        smoke,
        cache,
        activatedCapability: capability,
        status: "activated"
      });
      await this.receiptStore.save(receipt);
      this.overlay.activate(need.missionId, capability);
      return { capability, receipt };
    } finally {
      if (sandbox) this.sandboxManager.destroy(sandbox);
      if (materialized) await this.materializer.cleanup?.(materialized);
    }
  }

  private async activateTrustedCache(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    materialized: MaterializedCapability;
    identity: CapabilitySourceIdentity;
    cacheHit: TrustedCapabilityCacheHit;
  }): Promise<CapabilityAcquisitionOutcome> {
    // Cached security findings are evidence about exact bytes. Rebind only the
    // per-discovery candidate identity so the new Mission receipt cannot point
    // at a previous Mission's transient candidate id.
    const security: SecurityAssessment = {
      ...structuredClone(input.cacheHit.record.security),
      candidateId: input.candidate.id
    };
    const policy = this.policy.evaluateSecurity(security);
    const cache: AcquisitionReceipt["cache"] = {
      status: "reused",
      cacheKey: input.cacheHit.record.cacheKey
    };
    await this.assertRiskAndPolicy({ ...input, security, policy, cache });
    const approval = await this.requireApproval({ ...input, security, policy, cache });

    let capability: CapabilityDescriptor;
    try {
      capability = withProvenance(await this.activator.activate({
        candidate: { ...input.candidate, status: "verified" },
        need: input.need,
        materialized: input.materialized,
        sandboxRoot: input.cacheHit.bundleRoot,
        security
      }), input.identity, "trusted-cache");
      assertActivatedCapability(capability, input.need, input.materialized);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const receipt = this.receipt({
        candidate: input.candidate,
        need: input.need,
        materialized: input.materialized,
        security,
        policy,
        approval,
        smoke: input.cacheHit.record.smoke,
        cache,
        status: "activation_failed",
        reason: `Trusted-cache capability activation failed: ${reason}`
      });
      await this.receiptStore.save(receipt);
      throw new CapabilityAcquisitionError(receipt.reason!, receipt);
    }

    const receipt = this.receipt({
      candidate: input.candidate,
      need: input.need,
      materialized: input.materialized,
      security,
      policy,
      approval,
      smoke: input.cacheHit.record.smoke,
      cache,
      activatedCapability: capability,
      status: "activated_from_trusted_cache"
    });
    await this.receiptStore.save(receipt);
    this.overlay.activate(input.need.missionId, capability);
    return { capability, receipt };
  }

  private async assertRiskAndPolicy(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    materialized: MaterializedCapability;
    security: SecurityAssessment;
    policy: PolicyDecision;
    cache?: AcquisitionReceipt["cache"];
  }): Promise<void> {
    if (!riskWithinLimit(input.security.overall, input.need.maxRisk)) {
      const receipt = this.receipt({
        ...input,
        status: "rejected",
        reason: `Candidate risk ${input.security.overall} exceeds need maxRisk ${input.need.maxRisk}`
      });
      await this.receiptStore.save(receipt);
      throw new CapabilityAcquisitionError(receipt.reason!, receipt);
    }
    if (input.policy.action === "deny") {
      const receipt = this.receipt({
        ...input,
        status: "rejected",
        reason: input.policy.reason
      });
      await this.receiptStore.save(receipt);
      throw new CapabilityAcquisitionError(input.policy.reason, receipt);
    }
  }

  private async requireApproval(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    materialized: MaterializedCapability;
    security: SecurityAssessment;
    policy: PolicyDecision;
    cache?: AcquisitionReceipt["cache"];
  }): Promise<AcquisitionReceipt["approval"] | undefined> {
    if (input.policy.action !== "require_approval") return undefined;
    if (!this.approvalBroker) {
      const receipt = this.receipt({
        ...input,
        status: "approval_rejected",
        reason: "Capability acquisition requires an approval broker"
      });
      await this.receiptStore.save(receipt);
      throw new CapabilityAcquisitionError(receipt.reason!, receipt);
    }

    const decision = await this.approvalBroker.requestApproval({
      missionId: input.need.missionId,
      candidateId: input.candidate.id,
      capabilityNeedId: input.need.id,
      title: `Approve external capability: ${input.candidate.name}`,
      reason: input.policy.reason,
      details: {
        sourceUri: input.candidate.sourceUri,
        resolvedRevision: input.materialized.resolvedRevision,
        contentHash: input.materialized.contentHash,
        securityOverall: input.security.overall,
        findings: input.security.findings,
        requestedPermissions: input.security.requestedPermissions,
        trustedCacheKey: input.cache?.status === "reused" ? input.cache.cacheKey : undefined,
        trustedCacheReused: input.cache?.status === "reused"
      }
    });
    const approval: NonNullable<AcquisitionReceipt["approval"]> = {
      approved: decision.approved,
      ...(decision.actor ? { actor: decision.actor } : {}),
      decidedAt: new Date().toISOString()
    };
    if (!decision.approved) {
      const receipt = this.receipt({
        ...input,
        approval,
        status: "approval_rejected",
        reason: "User approval rejected external capability activation"
      });
      await this.receiptStore.save(receipt);
      throw new CapabilityAcquisitionError(receipt.reason!, receipt);
    }
    return approval;
  }

  private receipt(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    materialized: MaterializedCapability;
    security: SecurityAssessment;
    policy: PolicyDecision;
    approval?: AcquisitionReceipt["approval"];
    smoke?: AcquisitionReceipt["smoke"];
    cache?: AcquisitionReceipt["cache"];
    activatedCapability?: CapabilityDescriptor;
    status: AcquisitionReceiptStatus;
    reason?: string;
  }): AcquisitionReceipt {
    return {
      id: randomUUID(),
      missionId: input.need.missionId,
      capabilityNeedId: input.need.id,
      candidateId: input.candidate.id,
      sourceType: input.candidate.sourceType,
      sourceUri: input.candidate.sourceUri,
      resolvedRevision: input.materialized.resolvedRevision,
      contentHash: input.materialized.contentHash,
      allowedRisk: input.need.maxRisk,
      security: input.security,
      policy: input.policy,
      ...(input.approval ? { approval: input.approval } : {}),
      ...(input.smoke ? { smoke: input.smoke } : {}),
      ...(input.cache ? { cache: input.cache } : {}),
      ...(input.activatedCapability ? { activatedCapability: input.activatedCapability } : {}),
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: new Date().toISOString()
    };
  }
}

function sourceIdentity(candidate: CapabilityCandidate, materialized: MaterializedCapability): CapabilitySourceIdentity {
  return {
    sourceUri: candidate.sourceUri,
    sourceType: candidate.sourceType,
    resolvedRevision: materialized.resolvedRevision,
    contentHash: materialized.contentHash
  };
}

function withProvenance(
  capability: CapabilityDescriptor,
  identity: CapabilitySourceIdentity,
  source: "external" | "trusted-cache"
): CapabilityDescriptor {
  return {
    ...capability,
    provenance: {
      source,
      sourceRef: identity.sourceUri,
      revision: identity.resolvedRevision,
      contentHash: identity.contentHash
    }
  };
}

function assertMaterialization(candidate: CapabilityCandidate, materialized: MaterializedCapability): void {
  if (materialized.candidateId !== candidate.id) {
    throw new CapabilityAcquisitionError(`Materializer returned wrong candidate id for ${candidate.id}`);
  }
  if (materialized.sourceUri !== candidate.sourceUri || materialized.sourceType !== candidate.sourceType) {
    throw new CapabilityAcquisitionError(`Materializer provenance mismatch for ${candidate.id}`);
  }
  if (!materialized.resolvedRevision.trim()) {
    throw new CapabilityAcquisitionError(`Materializer did not pin revision for ${candidate.id}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(materialized.contentHash)) {
    throw new CapabilityAcquisitionError(`Materializer returned invalid content hash for ${candidate.id}`);
  }
}

function assertActivatedCapability(
  capability: CapabilityDescriptor,
  need: CapabilityNeed,
  materialized: MaterializedCapability
): void {
  if (!capability.available) throw new CapabilityAcquisitionError("Activator returned unavailable capability");
  if (capability.scope !== "mission") throw new CapabilityAcquisitionError("Acquired capability must be mission-local");
  if (capability.hostNative) throw new CapabilityAcquisitionError("Externally acquired capability cannot be hostNative");
  if (capability.revision !== materialized.resolvedRevision) {
    throw new CapabilityAcquisitionError(`Activated capability revision mismatch for need ${need.id}`);
  }
  if (capability.provenance?.revision !== materialized.resolvedRevision || capability.provenance?.contentHash !== materialized.contentHash) {
    throw new CapabilityAcquisitionError(`Activated capability provenance mismatch for need ${need.id}`);
  }
}

function riskWithinLimit(actual: RiskLevel, allowed: RiskLevel): boolean {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, blocked: 3 };
  return actual !== "blocked" && rank[actual] <= rank[allowed];
}
