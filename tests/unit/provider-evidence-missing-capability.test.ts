import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import { VerificationEvidenceCollectorRegistry } from "../../src/core/verification/evidence-collector.ts";
import { createDefaultVerificationProfileRegistry } from "../../src/core/verification/verification-profile.ts";
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
  HostDescriptor
} from "../../src/hosts/host-adapter.ts";
import {
  STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
  StructuredProviderEvidenceCollector
} from "../../src/runtime/provider-evidence-collector.ts";

class NoBrowserCapabilityHost implements HostAdapter {
  invokeCalls = 0;
  async describeHost(): Promise<HostDescriptor> { return { type: "no-browser-host", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: "2026-10-29T00:00:00.000Z"
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { throw new Error("not used"); }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> { return { status: "unsupported", reason: "not used" }; }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {}
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    this.invokeCalls += 1;
    throw new Error("must not be invoked when capability is absent");
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

const artifact: Artifact = {
  id: "site",
  missionId: "mission-provider-missing",
  logicalName: "site",
  type: "website",
  version: 1,
  status: "candidate",
  uri: "/workspace/index.html",
  contentHash: `sha256:${"a".repeat(64)}`,
  mimeType: "text/html",
  producedByAttemptId: "attempt-1",
  sourceArtifactRefs: [],
  createdAt: "2026-10-29T00:00:00.000Z"
};

test("configured provider route does not fabricate Evidence when the live HostAdapter lacks the capability", async () => {
  const host = new NoBrowserCapabilityHost();
  const collector = new StructuredProviderEvidenceCollector(host, {
    id: "browser-prod",
    capabilityId: "browser.runtime.prod",
    provider: "browser-provider",
    protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
    evidenceKind: "browser-runtime",
    readOnly: true,
    allowedPermissions: ["browser-read"]
  });
  const registry = new VerificationEvidenceCollectorRegistry([collector]);
  const profile = createDefaultVerificationProfileRegistry().select(artifact).profile;

  const collection = await registry.collect({ artifact, profile, maxInspectionBytes: 4096 });
  assert.deepEqual(collection.collected, []);
  assert.equal(collection.attemptedCollectorIds.length, 1);
  assert.equal(collection.failures.length, 1);
  assert.equal(collection.failures[0]?.collectorId, "provider-evidence:browser-prod");
  assert.deepEqual(collection.failures[0]?.kinds, ["browser-runtime"]);
  assert.match(collection.failures[0]?.reason ?? "", /capability is absent: browser\.runtime\.prod/);
  assert.equal(host.invokeCalls, 0);
});
