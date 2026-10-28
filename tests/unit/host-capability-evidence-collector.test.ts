import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
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
} from "../../src/hosts/deepseek/host-adapter.ts";
import {
  TrustedHostCapabilityEvidenceCollector,
  parseTrustedHostCapabilityEvidenceBindingsJson,
  type TrustedHostCapabilityEvidenceBinding
} from "../../src/runtime/host-capability-evidence-collector.ts";
import { createDefaultVerificationProfileRegistry } from "../../src/core/verification/verification-profile.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";

function capability(patch: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: "browser.inspect",
    kind: "tool",
    name: "Browser Inspect",
    description: "Read-only browser runtime inspection",
    hostNative: true,
    available: true,
    permissions: [],
    revision: "browser-r1",
    scope: "host",
    functions: ["verification.browser.inspect"],
    accepts: ["website"],
    produces: ["verification-evidence"],
    routing: { executionMode: "host-capability", isolation: "host" },
    cost: { monetaryClass: "low", latencyClass: "interactive", metered: false },
    native: { provider: "fixture", nativeId: "browser-inspector" },
    provenance: { source: "host", revision: "browser-r1" },
    ...patch
  };
}

class EvidenceHost implements HostAdapter {
  readonly invocations: HostCapabilityInvocation[] = [];
  private readonly descriptor: CapabilityDescriptor;
  private readonly result: HostCapabilityResult;

  constructor(descriptor: CapabilityDescriptor, result: HostCapabilityResult = {
    ok: true,
    output: {
      result: "supports",
      summary: "route loaded and interaction completed",
      inspectionPayload: { route: "/", consoleErrors: [] },
      claim: "provider must not be allowed to replace durable Runtime claim",
      sourceRef: "https://user:secret@example.test/?token=secret"
    }
  }) {
    this.descriptor = descriptor;
    this.result = result;
  }

  async describeHost(): Promise<HostDescriptor> { return { type: "fixture-host", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 9,
      host: await this.describeHost(),
      capabilities: [this.descriptor],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: true,
      capturedAt: "2026-10-29T00:00:00.000Z"
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { throw new Error("not used"); }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> { return { status: "unsupported", reason: "not used" }; }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {}
  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    this.invocations.push(structuredClone(request));
    return structuredClone(this.result);
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

function binding(patch: Partial<TrustedHostCapabilityEvidenceBinding> = {}): TrustedHostCapabilityEvidenceBinding {
  return {
    id: "browser-runtime",
    capabilityId: "browser.inspect",
    evidenceKind: "browser-runtime",
    evidenceType: "runtime-check",
    profileKinds: ["website"],
    artifactTypes: ["website"],
    expectedFunction: "verification.browser.inspect",
    readOnly: true,
    allowedPermissions: [],
    allowMetered: false,
    maxMonetaryClass: "low",
    claim: "Configured host browser inspection observed the website runtime.",
    maxOutputBytes: 64 * 1024,
    ...patch
  };
}

const artifact: Artifact = {
  id: "site",
  missionId: "mission-host-evidence",
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
const profile = createDefaultVerificationProfileRegistry().select(artifact).profile;

test("trusted host evidence collector invokes only the explicitly bound semantic host capability", async () => {
  const host = new EvidenceHost(capability());
  const collector = new TrustedHostCapabilityEvidenceCollector(host, binding());
  assert.equal(collector.supports({ artifact, profile, maxInspectionBytes: 4096 }), true);

  const drafts = await collector.collect({ artifact, profile, maxInspectionBytes: 4096 });
  assert.equal(host.invocations.length, 1);
  assert.equal(host.invocations[0]?.capabilityId, "browser.inspect");
  assert.equal((host.invocations[0]?.input as any).operation, "mission.verification.collect_evidence");
  assert.equal((host.invocations[0]?.input as any).evidenceKind, "browser-runtime");
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.kind, "browser-runtime");
  assert.equal(drafts[0]?.result, "supports");
  assert.equal(drafts[0]?.claim, "Configured host browser inspection observed the website runtime.");
  assert.equal(drafts[0]?.sourceRef, "host-capability:browser.inspect@browser-r1");
  assert.equal((drafts[0]?.details as any).provider, "fixture");
  assert.equal(JSON.stringify(drafts[0]?.details).includes("secret"), false);
  assert.deepEqual(drafts[0]?.inspectionPayload, {
    summary: "route loaded and interaction completed",
    evidence: { route: "/", consoleErrors: [] }
  });
});

test("host evidence collector fail-closes semantic, permission, routing, cost and metered mismatches before invocation", async () => {
  const cases: Array<[string, CapabilityDescriptor, Partial<TrustedHostCapabilityEvidenceBinding>, RegExp]> = [
    ["missing semantic function", capability({ functions: ["other.function"] }), {}, /does not advertise required semantic function/],
    ["wrong route", capability({ routing: { executionMode: "host-agent" } }), {}, /executionMode=host-capability/],
    ["unapproved permission", capability({ permissions: ["network-read"] }), {}, /permissions not approved as read-only/],
    ["metered", capability({ cost: { monetaryClass: "low", metered: true } }), {}, /does not allow metered use/],
    ["high cost", capability({ cost: { monetaryClass: "high", metered: false } }), {}, /exceeds binding limit low/],
    ["not host scoped", capability({ scope: "mission", hostNative: false }), {}, /host-native and host-scoped/]
  ];

  for (const [label, descriptor, bindingPatch, pattern] of cases) {
    const host = new EvidenceHost(descriptor);
    const collector = new TrustedHostCapabilityEvidenceCollector(host, binding(bindingPatch));
    await assert.rejects(() => collector.collect({ artifact, profile, maxInspectionBytes: 4096 }), pattern, label);
    assert.equal(host.invocations.length, 0, label);
  }
});

test("host evidence binding parser requires explicit read-only valid typed configuration", () => {
  const parsed = parseTrustedHostCapabilityEvidenceBindingsJson(JSON.stringify([binding()]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.evidenceKind, "browser-runtime");

  assert.throws(
    () => parseTrustedHostCapabilityEvidenceBindingsJson(JSON.stringify([{ ...binding(), readOnly: false }])),
    /readOnly=true/
  );
  assert.throws(
    () => parseTrustedHostCapabilityEvidenceBindingsJson(JSON.stringify([{ ...binding(), evidenceKind: "imaginary-evidence" }])),
    /unsupported evidenceKind/
  );
  assert.throws(
    () => parseTrustedHostCapabilityEvidenceBindingsJson(JSON.stringify([{ ...binding(), profileKinds: ["imaginary-profile"] }])),
    /unsupported profile kind/
  );
});

test("host evidence collector rejects provider failures, malformed verdicts and oversized output", async () => {
  const failedHost = new EvidenceHost(capability(), { ok: false, error: "browser unavailable" });
  await assert.rejects(
    () => new TrustedHostCapabilityEvidenceCollector(failedHost, binding()).collect({ artifact, profile, maxInspectionBytes: 4096 }),
    /browser unavailable/
  );

  const malformed = new EvidenceHost(capability(), { ok: true, output: { result: "maybe" } });
  await assert.rejects(
    () => new TrustedHostCapabilityEvidenceCollector(malformed, binding()).collect({ artifact, profile, maxInspectionBytes: 4096 }),
    /unsupported result/
  );

  const oversized = new EvidenceHost(capability(), {
    ok: true,
    output: { result: "supports", inspectionPayload: { body: "x".repeat(4_096) } }
  });
  await assert.rejects(
    () => new TrustedHostCapabilityEvidenceCollector(oversized, binding({ maxOutputBytes: 1024 })).collect({ artifact, profile, maxInspectionBytes: 4096 }),
    /output exceeds 1024 bytes/
  );
});
