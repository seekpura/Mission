import { randomUUID } from "node:crypto";
import type {
  CapabilityCandidate,
  CapabilityDescriptor,
  CapabilityNeed,
  RiskLevel
} from "../domain/capability.ts";
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
 * immutable materialization -> static scan -> need/policy gate -> optional user
 * approval -> isolated smoke -> mission-local activation -> receipt -> overlay.
 */
export class CapabilityAcquisitionTransaction {
  private readonly materializer: CapabilityMaterializer;
  private readonly sandboxManager: SandboxManager;
  private readonly smokeRunner: IsolatedCapabilitySmokeRunner;
  private readonly activator: MaterializedCapabilityActivator;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly receiptStore: AcquisitionReceiptStore;
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
      const security = this.scanner.scan(pinnedCandidate, materialized.root);
      const policy = this.policy.evaluateSecurity(security);

      if (!riskWithinLimit(security.overall, need.maxRisk)) {
        const receipt = this.receipt({
          candidate: pinnedCandidate,
          need,
          materialized,
          security,
          policy,
          status: "rejected",
          reason: `Candidate risk ${security.overall} exceeds need maxRisk ${need.maxRisk}`
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(receipt.reason!, receipt);
      }

      if (policy.action === "deny") {
        const receipt = this.receipt({
          candidate: pinnedCandidate,
          need,
          materialized,
          security,
          policy,
          status: "rejected",
          reason: policy.reason
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(policy.reason, receipt);
      }

      let approval: AcquisitionReceipt["approval"];
      if (policy.action === "require_approval") {
        if (!this.approvalBroker) {
          const receipt = this.receipt({
            candidate: pinnedCandidate,
            need,
            materialized,
            security,
            policy,
            status: "approval_rejected",
            reason: "High-risk acquisition requires an approval broker"
          });
          await this.receiptStore.save(receipt);
          throw new CapabilityAcquisitionError(receipt.reason!, receipt);
        }

        const decision = await this.approvalBroker.requestApproval({
          missionId: need.missionId,
          candidateId: pinnedCandidate.id,
          capabilityNeedId: need.id,
          title: `Approve external capability: ${pinnedCandidate.name}`,
          reason: policy.reason,
          details: {
            sourceUri: pinnedCandidate.sourceUri,
            resolvedRevision: materialized.resolvedRevision,
            contentHash: materialized.contentHash,
            securityOverall: security.overall,
            findings: security.findings,
            requestedPermissions: security.requestedPermissions
          }
        });
        approval = {
          approved: decision.approved,
          ...(decision.actor ? { actor: decision.actor } : {}),
          decidedAt: new Date().toISOString()
        };
        if (!decision.approved) {
          const receipt = this.receipt({
            candidate: pinnedCandidate,
            need,
            materialized,
            security,
            policy,
            approval,
            status: "approval_rejected",
            reason: "User approval rejected external capability activation"
          });
          await this.receiptStore.save(receipt);
          throw new CapabilityAcquisitionError(receipt.reason!, receipt);
        }
      }

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
        capability = await this.activator.activate({
          candidate: { ...pinnedCandidate, status: "verified" },
          need,
          materialized,
          sandboxRoot: sandbox.candidateRoot,
          security
        });
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
          status: "activation_failed",
          reason: `Mission-local capability activation failed: ${reason}`
        });
        await this.receiptStore.save(receipt);
        throw new CapabilityAcquisitionError(receipt.reason!, receipt);
      }

      const receipt = this.receipt({
        candidate: pinnedCandidate,
        need,
        materialized,
        security,
        policy,
        approval,
        smoke,
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

  private receipt(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    materialized: MaterializedCapability;
    security: ReturnType<StaticSecurityScanner["scan"]>;
    policy: PolicyDecision;
    approval?: AcquisitionReceipt["approval"];
    smoke?: AcquisitionReceipt["smoke"];
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
      ...(input.activatedCapability ? { activatedCapability: input.activatedCapability } : {}),
      status: input.status,
      ...(input.reason ? { reason: input.reason } : {}),
      createdAt: new Date().toISOString()
    };
  }
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
}

function riskWithinLimit(actual: RiskLevel, allowed: RiskLevel): boolean {
  const rank: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, blocked: 3 };
  return actual !== "blocked" && rank[actual] <= rank[allowed];
}
