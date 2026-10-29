import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
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
  StructuredProviderEvidenceCollector,
  parseTrustedProviderEvidenceRoutesJson,
  providerEvidenceSpec,
  type TrustedProviderEvidenceRoute
} from "../../src/runtime/provider-evidence-collector.ts";

const artifact: Artifact = {
  id: "site",
  missionId: "mission-provider-evidence",
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

function route(patch: Partial<TrustedProviderEvidenceRoute> = {}): TrustedProviderEvidenceRoute {
  return {
    id: "browser-prod",
    capabilityId: "browser.inspect.prod",
    provider: "browser-provider",
    protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
    nativeId: "browser-inspector-v3",
    evidenceKind: "browser-runtime",
    readOnly: true,
    allowedPermissions: ["browser-read"],
    allowMetered: false,
    maxMonetaryClass: "low",
    maxOutputBytes: 64 * 1024,
    ...patch
  };
}

function capability(patch: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id: "browser.inspect.prod",
    kind: "tool",
    name: "Provider Browser Inspect",
    description: "Structured browser verification provider",
    hostNative: true,
    available: true,
    permissions: ["browser-read"],
    revision: "browser-r7",
    scope: "host",
    functions: ["verification.browser.inspect"],
    accepts: ["website"],
    produces: ["verification-evidence"],
    routing: { executionMode: "host-capability", isolation: "remote" },
    cost: { monetaryClass: "low", latencyClass: "interactive", metered: false },
    native: {
      provider: "browser-provider",
      nativeId: "browser-inspector-v3",
      protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
      loadMode: "remote"
    },
    provenance: { source: "host", revision: "browser-r7" },
    ...patch
  };
}

function output(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
    evidenceKind: "browser-runtime",
    subject: { artifactId: artifact.id, contentHash: artifact.contentHash },
    result: "supports",
    observedAt: "2026-10-29T00:30:00.000Z",
    summary: "root route loaded and interactive behavior was observed",
    observation: { route: "/", loaded: true, consoleErrors: [] },
    claim: "provider supplied claim must never become durable Runtime authority",
    sourceRef: "provider-controlled-source",
    ...patch
  };
}

class ProviderHost implements HostAdapter {
  readonly invocations: HostCapabilityInvocation[] = [];
  private readonly descriptor: CapabilityDescriptor;
  private readonly response: HostCapabilityResult;

  constructor(descriptor: CapabilityDescriptor, response: HostCapabilityResult = { ok: true, output: output() }) {
    this.descriptor = descriptor;
    this.response = response;
  }

  async describeHost(): Promise<HostDescriptor> { return { type: "fixture-provider-host", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 12,
      host: await this.describeHost(),
      capabilities: [this.descriptor],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: true,
      capturedAt: "2026-10-29T00:30:00.000Z"
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { throw new Error("not used"); }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> { return { status: "unsupported", reason: "not used" }; }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {}
  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    this.invocations.push(structuredClone(request));
    return structuredClone(this.response);
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

test("structured provider evidence binds provider/protocol and exact artifact subject before producing Runtime Evidence", async () => {
  const host = new ProviderHost(capability());
  const collector = new StructuredProviderEvidenceCollector(host, route());

  const drafts = await collector.collect({ artifact, profile, maxInspectionBytes: 16 * 1024 });
  assert.equal(host.invocations.length, 1);
  assert.equal(host.invocations[0]?.capabilityId, "browser.inspect.prod");
  const request = host.invocations[0]?.input as Record<string, any>;
  assert.equal(request.contract, STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL);
  assert.equal(request.evidenceKind, "browser-runtime");
  assert.deepEqual(request.subject, { artifactId: artifact.id, contentHash: artifact.contentHash });

  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.kind, "browser-runtime");
  assert.equal(drafts[0]?.result, "supports");
  assert.equal(drafts[0]?.claim, providerEvidenceSpec("browser-runtime").claim);
  assert.equal(drafts[0]?.sourceRef, "provider-capability:browser-provider:browser.inspect.prod@browser-r7");
  assert.equal((drafts[0]?.details as any).protocol, STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL);
  assert.equal(JSON.stringify(drafts[0]).includes("provider supplied claim"), false);
  assert.equal(JSON.stringify(drafts[0]).includes("provider-controlled-source"), false);
  assert.deepEqual(drafts[0]?.inspectionPayload, {
    summary: "root route loaded and interactive behavior was observed",
    evidence: { route: "/", loaded: true, consoleErrors: [] }
  });
});

test("provider route derives semantic function, profile, evidence type and durable claim from Runtime-owned kind spec", () => {
  const browser = providerEvidenceSpec("browser-runtime");
  assert.equal(browser.expectedFunction, "verification.browser.inspect");
  assert.equal(browser.evidenceType, "runtime-check");
  assert.deepEqual(browser.profileKinds, ["website"]);
  assert.deepEqual(browser.artifactTypes, ["website"]);

  const code = providerEvidenceSpec("executable-test");
  assert.equal(code.expectedFunction, "verification.code.test");
  assert.equal(code.evidenceType, "test-result");
  assert.deepEqual(code.profileKinds, ["code"]);
});

test("provider evidence fails closed on provider, protocol, native id, semantic and output-class mismatches before invocation", async () => {
  const cases: Array<[string, CapabilityDescriptor, RegExp]> = [
    ["provider", capability({ native: { provider: "other", nativeId: "browser-inspector-v3", protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL } }), /does not match trusted route browser-provider/],
    ["protocol", capability({ native: { provider: "browser-provider", nativeId: "browser-inspector-v3", protocol: "vendor-json/v2" } }), /does not match trusted route mission-evidence\/v1/],
    ["native id", capability({ native: { provider: "browser-provider", nativeId: "other-native", protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL } }), /nativeId .* does not match trusted route/],
    ["semantic", capability({ functions: ["verification.browser.screenshot"] }), /does not advertise required semantic function/],
    ["output class", capability({ produces: ["screenshot"] }), /must advertise verification-evidence output/]
  ];

  for (const [label, descriptor, pattern] of cases) {
    const host = new ProviderHost(descriptor);
    const collector = new StructuredProviderEvidenceCollector(host, route());
    await assert.rejects(() => collector.collect({ artifact, profile, maxInspectionBytes: 4096 }), pattern, label);
    assert.equal(host.invocations.length, 0, label);
  }
});

test("provider output cannot be replayed for a different artifact hash or evidence kind", async () => {
  const wrongSubject = new ProviderHost(capability(), {
    ok: true,
    output: output({ subject: { artifactId: artifact.id, contentHash: "sha256:wrong" } })
  });
  await assert.rejects(
    () => new StructuredProviderEvidenceCollector(wrongSubject, route()).collect({ artifact, profile, maxInspectionBytes: 4096 }),
    /subject does not match the exact artifact id\/contentHash/
  );

  const wrongKind = new ProviderHost(capability(), {
    ok: true,
    output: output({ evidenceKind: "accessibility-check" })
  });
  await assert.rejects(
    () => new StructuredProviderEvidenceCollector(wrongKind, route()).collect({ artifact, profile, maxInspectionBytes: 4096 }),
    /does not match requested browser-runtime/
  );
});

test("provider route parser rejects mutable, unknown-protocol and arbitrary evidence kinds", () => {
  const parsed = parseTrustedProviderEvidenceRoutesJson(JSON.stringify([route()]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0]?.provider, "browser-provider");

  assert.throws(
    () => parseTrustedProviderEvidenceRoutesJson(JSON.stringify([{ ...route(), readOnly: false }])),
    /readOnly=true/
  );
  assert.throws(
    () => parseTrustedProviderEvidenceRoutesJson(JSON.stringify([{ ...route(), protocol: "vendor-untyped/v1" }])),
    /protocol must be mission-evidence\/v1/
  );
  assert.throws(
    () => parseTrustedProviderEvidenceRoutesJson(JSON.stringify([{ ...route(), evidenceKind: "website-source" }])),
    /unsupported evidenceKind/
  );
});
