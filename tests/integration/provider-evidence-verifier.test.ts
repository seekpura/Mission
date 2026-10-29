import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
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
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";
import {
  STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
  createStructuredProviderEvidenceCollectors,
  type TrustedProviderEvidenceRoute
} from "../../src/runtime/provider-evidence-collector.ts";
import { createDefaultVerificationEvidenceCollectorRegistry } from "../../src/runtime/verification-evidence-collectors.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class StructuredBrowserProviderHost implements HostAdapter {
  readonly invocations: HostCapabilityInvocation[] = [];

  async describeHost(): Promise<HostDescriptor> { return { type: "structured-provider-fixture", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 3,
      host: await this.describeHost(),
      capabilities: [{
        id: "browser.runtime.prod",
        kind: "tool",
        name: "Production Browser Runtime",
        description: "Read-only browser runtime evidence provider",
        hostNative: true,
        available: true,
        permissions: ["browser-read"],
        revision: "browser-provider-r3",
        scope: "host",
        functions: ["verification.browser.inspect"],
        accepts: ["website"],
        produces: ["verification-evidence"],
        routing: { executionMode: "host-capability", isolation: "remote" },
        cost: { monetaryClass: "low", latencyClass: "interactive", metered: false },
        native: {
          provider: "browser-provider",
          nativeId: "browser-runtime-v3",
          protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
          loadMode: "remote"
        },
        provenance: { source: "host", revision: "browser-provider-r3" }
      }],
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
    const input = request.input as any;
    return {
      ok: true,
      output: {
        schemaVersion: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
        evidenceKind: "browser-runtime",
        subject: structuredClone(input.subject),
        result: "supports",
        observedAt: "2026-10-29T00:10:00.000Z",
        summary: "Root route loaded, primary navigation responded and keyboard focus reached the primary action.",
        observation: {
          route: "/",
          viewport: "1440x900",
          interactions: ["primary-navigation", "keyboard-focus"],
          blockingConsoleErrors: 0
        },
        claim: "provider cannot replace Runtime durable claim",
        sourceRef: "provider cannot replace Runtime source"
      }
    };
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

class EvidenceAwareTransport implements HostJsonTransport {
  readonly requests: HostJsonRequest[] = [];
  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    const payload = input.input as any;
    const evidenceRefs = (payload.runtimeEvidence as Array<{ id: string; result: string }>)
      .filter(evidence => evidence.result === "supports")
      .map(evidence => evidence.id);
    return {
      overall: "pass",
      checkResults: payload.verificationProfile.checks.map((check: any) => ({
        id: check.id,
        status: "pass",
        evidenceRefs
      })),
      evidenceRefs,
      gapAssessments: []
    };
  }
}

const state: MissionState = {
  missionId: "mission-provider-browser-evidence",
  status: "active",
  revision: 1,
  missionSpecRevision: 1,
  acceptanceRevision: 1,
  strategyRevision: 1,
  graphRevision: 1,
  environmentSnapshotRevision: 1,
  activeWorkstreamIds: [],
  activeWorkItemIds: ["work-site"],
  readyWorkItemIds: [],
  blockedWorkItemIds: [],
  verifyingWorkItemIds: ["work-site"],
  openGapIds: [],
  blockingGapIds: [],
  activeExecutionIds: [],
  pendingApprovalIds: [],
  finalArtifactRefs: [],
  lastEventSequence: 1
};

const workItem: WorkItem = {
  id: "work-site",
  missionId: state.missionId,
  purpose: "production",
  objective: "Deliver a usable responsive website with working navigation and accessible controls",
  status: "verifying",
  requirementRefs: ["req-site"],
  gapRefs: [],
  inputArtifactRefs: [],
  expectedOutputs: [{ logicalName: "site", type: "website", required: true }],
  localAcceptanceCriteria: [
    { id: "site-navigation", description: "Primary navigation works in a browser", priority: "required" },
    { id: "site-keyboard", description: "Primary control is keyboard reachable", priority: "required" }
  ],
  capabilityNeedRefs: [],
  priority: 1,
  graphRevision: 1,
  createdBy: "planner",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z"
};

const route: TrustedProviderEvidenceRoute = {
  id: "website-browser-provider",
  capabilityId: "browser.runtime.prod",
  provider: "browser-provider",
  protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
  nativeId: "browser-runtime-v3",
  evidenceKind: "browser-runtime",
  readOnly: true,
  allowedPermissions: ["browser-read"],
  maxMonetaryClass: "low"
};

test("structured provider browser response becomes durable Runtime Evidence and satisfies website profile gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-provider-browser-evidence-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const host = new StructuredBrowserProviderHost();
  const transport = new EvidenceAwareTransport();

  try {
    const path = join(root, "index.html");
    const html = "<!doctype html><html><body><nav><a href='/'>Home</a></nav><main><h1>Hello</h1><button>Continue</button></main></body></html>";
    writeFileSync(path, html, "utf8");
    const artifact: Artifact = {
      id: "site",
      missionId: state.missionId,
      logicalName: "site",
      type: "website",
      version: 1,
      status: "candidate",
      uri: path,
      contentHash: `sha256:${createHash("sha256").update(html).digest("hex")}`,
      mimeType: "text/html",
      sizeBytes: Buffer.byteLength(html),
      producedByAttemptId: "attempt-site",
      sourceArtifactRefs: [],
      createdAt: "2026-10-29T00:00:00.000Z"
    };
    const providerCollectors = createStructuredProviderEvidenceCollectors(host, [route]);
    const verifier = new HostArtifactVerifier({
      transport,
      events,
      reader,
      evidenceCollectors: createDefaultVerificationEvidenceCollectorRegistry(providerCollectors)
    });

    const result = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(result.verificationProfileId, "website-mission-review-v1");
    assert.equal(result.overall, "pass");
    assert.equal(host.invocations.length, 1);
    const invocation = host.invocations[0]?.input as any;
    assert.equal(invocation.contract, STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL);
    assert.deepEqual(invocation.subject, { artifactId: artifact.id, contentHash: artifact.contentHash });

    const evidence = reader.readEvidence(state.missionId, "site@1");
    const runtimeEvidence = evidence.find(item => item.kind === "browser-runtime");
    assert.ok(runtimeEvidence);
    assert.equal(runtimeEvidence?.collectorId, "provider-evidence:website-browser-provider");
    assert.equal(runtimeEvidence?.result, "supports");
    assert.equal((runtimeEvidence?.details as any).provider, "browser-provider");
    assert.equal((runtimeEvidence?.details as any).protocol, STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL);
    assert.equal(JSON.stringify(runtimeEvidence).includes("blockingConsoleErrors"), false);
    assert.equal(JSON.stringify(runtimeEvidence).includes("provider cannot replace Runtime"), false);

    const hostReviewInput = transport.requests[0]?.input as any;
    const transientRuntime = hostReviewInput.runtimeEvidence.find((item: any) => item.kind === "browser-runtime");
    assert.equal(transientRuntime.inspectionPayload.evidence.blockingConsoleErrors, 0);
    assert.deepEqual(transientRuntime.inspectionPayload.evidence.interactions, ["primary-navigation", "keyboard-focus"]);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
