import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityCandidate, CapabilityNeed, SecurityAssessment } from "../../src/core/domain/capability.ts";
import {
  CapabilityAcquisitionTransaction
} from "../../src/core/capabilities/acquisition-transaction.ts";
import { FileAcquisitionReceiptStore } from "../../src/core/capabilities/acquisition-receipt.ts";
import {
  RepositoryCapabilityMaterializer,
  type RepositorySnapshotClient
} from "../../src/core/capabilities/materialization.ts";
import { MissionLocalDirectoryActivator } from "../../src/core/capabilities/mission-local-directory-activator.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import { FileTrustedCapabilityCache } from "../../src/core/capabilities/trusted-capability-cache.ts";
import { PolicyEngine, type PolicyDecision } from "../../src/core/policy/policy-engine.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import {
  IsolatedCapabilitySmokeRunner,
  type CapabilitySmokePlanResolver,
  type IsolatedSmokeExecutor,
  type SmokeExecutionResult
} from "../../src/core/capabilities/sandbox/isolated-smoke-runner.ts";

class ExactSnapshotClient implements RepositorySnapshotClient {
  async snapshot(input: { sourceUri: string; targetDirectory: string; requestedRevision?: string }) {
    writeFileSync(join(input.targetDirectory, "SKILL.md"), "# Exact trusted skill\nReturn a concise result.\n", "utf8");
    return { resolvedRevision: input.requestedRevision ?? "commit-exact-1" };
  }
}

class CountingSmokeExecutor implements IsolatedSmokeExecutor {
  readonly id = "cache-reuse-smoke";
  readonly isolationLevel = "container" as const;
  calls = 0;

  async execute(input: { cwd: string; command: string; args: string[]; timeoutMs?: number; env: Record<string, string> }): Promise<SmokeExecutionResult> {
    this.calls += 1;
    assert.equal(existsSync(join(input.cwd, "SKILL.md")), true);
    return { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" };
  }
}

class AlwaysApprovePolicy extends PolicyEngine {
  override evaluateSecurity(_assessment: SecurityAssessment): PolicyDecision {
    return {
      action: "require_approval",
      reason: "test requires per-Mission approval",
      constraints: ["mission-local"]
    };
  }
}

const smokeResolver: CapabilitySmokePlanResolver = {
  async resolve() { return { command: "validate", args: [], timeoutMs: 2_000 }; }
};

function candidate(id: string): CapabilityCandidate {
  return {
    id,
    sourceType: "github",
    sourceUri: "https://github.com/example/exact-skill",
    name: "example/exact-skill",
    description: "Exact skill fixture",
    candidateKind: "skill",
    status: "discovered"
  };
}

function need(missionId: string, id: string): CapabilityNeed {
  return {
    id,
    missionId,
    objective: "Use exact external skill",
    requiredFunctions: ["exact skill"],
    desiredInputs: ["text"],
    desiredOutputs: ["text"],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: [],
    gapRefs: []
  };
}

test("exact trusted-cache reuse skips duplicate smoke but never reuses another Mission's approval", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-cache-reuse-"));
  try {
    const smoke = new CountingSmokeExecutor();
    const overlay = new MissionCapabilityOverlay();
    const cache = new FileTrustedCapabilityCache(join(root, "trusted-cache"));
    const receipts = new FileAcquisitionReceiptStore(join(root, "receipts"));
    let approvals = 0;
    const transaction = new CapabilityAcquisitionTransaction({
      materializer: new RepositoryCapabilityMaterializer({
        stagingRoot: join(root, "staging"),
        client: new ExactSnapshotClient()
      }),
      sandboxManager: new SandboxManager(join(root, "sandboxes")),
      smokeRunner: new IsolatedCapabilitySmokeRunner(smoke, smokeResolver),
      activator: new MissionLocalDirectoryActivator(join(root, "activated")),
      overlay,
      receiptStore: receipts,
      trustedCache: cache,
      policy: new AlwaysApprovePolicy(),
      approvalBroker: {
        async requestApproval(request) {
          approvals += 1;
          return { approved: true, actor: `approver-${request.missionId}` };
        }
      }
    });

    const first = await transaction.acquire(candidate("candidate-1"), need("mission-1", "need-1"));
    const second = await transaction.acquire(candidate("candidate-2"), need("mission-2", "need-2"));

    assert.equal(first.receipt.status, "activated");
    assert.equal(first.receipt.cache?.status, "stored");
    assert.ok(first.receipt.cache?.cacheKey);
    assert.equal(second.receipt.status, "activated_from_trusted_cache");
    assert.equal(second.receipt.cache?.status, "reused");
    assert.equal(second.receipt.cache?.cacheKey, first.receipt.cache?.cacheKey);
    assert.equal(smoke.calls, 1, "second exact activation must reuse passing isolated smoke evidence");
    assert.equal(approvals, 2, "approval is per Mission and is never cached");
    assert.equal(second.receipt.approval?.actor, "approver-mission-2");
    assert.equal(second.receipt.security.candidateId, "candidate-2");
    assert.equal(second.capability.provenance?.source, "trusted-cache");
    assert.equal(second.capability.provenance?.contentHash, first.receipt.contentHash);
    assert.equal(existsSync(second.capability.invocationRef ?? ""), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
