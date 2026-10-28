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
} from "../../src/hosts/deepseek/host-adapter.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import {
  createTrustedHostCapabilityEvidenceCollectors,
  type TrustedHostCapabilityEvidenceBinding
} from "../../src/runtime/host-capability-evidence-collector.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";
import { createDefaultVerificationEvidenceCollectorRegistry } from "../../src/runtime/verification-evidence-collectors.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class BrowserEvidenceHost implements HostAdapter {
  readonly invocations: HostCapabilityInvocation[] = [];
  async describeHost(): Promise<HostDescriptor> { return { type: "browser-evidence-fixture", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [{
        id: "browser.runtime.inspect",
        kind: "tool",
        name: "Browser Runtime Inspector",
        description: "Read-only browser route, interaction and accessibility inspection",
        hostNative: true,
        available: true,
        permissions: ["browser-read"],
        revision: "browser-inspect-r1",
        scope: "host",
        functions: ["verification.browser.inspect"],
        accepts: ["website"],
        produces: ["verification-evidence"],
        routing: { executionMode: "host-capability", isolation: "host" },
        cost: { monetaryClass: "low", latencyClass: "interactive", metered: false },
        native: { provider: "fixture-browser", nativeId: "browser-inspector" },
        provenance: { source: "host", revision: "browser-inspect-r1" }
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
    return {
      ok: true,
      output: {
        result: "supports",
        summary: "Homepage loaded, primary navigation worked, keyboard focus reached the button, and no blocking console errors were observed.",
        inspectionPayload: {
          route: "/",
          viewport: "1440x900",
          interactions: ["primary-navigation", "keyboard-focus"],
          blockingConsoleErrors: 0
        }
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
  missionId: "mission-host-browser-evidence",
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

const binding: TrustedHostCapabilityEvidenceBinding = {
  id: "website-browser-runtime",
  capabilityId: "browser.runtime.inspect",
  evidenceKind: "browser-runtime",
  evidenceType: "runtime-check",
  profileKinds: ["website"],
  artifactTypes: ["website"],
  expectedFunction: "verification.browser.inspect",
  readOnly: true,
  allowedPermissions: ["browser-read"],
  maxMonetaryClass: "low",
  claim: "Configured host browser inspector observed required website runtime behavior."
};

test("explicit host-native browser evidence becomes durable Runtime Evidence and satisfies website profile gates", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-host-browser-evidence-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const host = new BrowserEvidenceHost();
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
    const hostCollectors = createTrustedHostCapabilityEvidenceCollectors(host, [binding]);
    const verifier = new HostArtifactVerifier({
      transport,
      events,
      reader,
      evidenceCollectors: createDefaultVerificationEvidenceCollectorRegistry(hostCollectors)
    });

    const result = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(result.verificationProfileId, "website-mission-review-v1");
    assert.equal(result.overall, "pass");
    assert.equal(host.invocations.length, 1);
    const request = host.invocations[0]?.input as any;
    assert.equal(request.operation, "mission.verification.collect_evidence");
    assert.equal(request.evidenceKind, "browser-runtime");
    assert.equal(request.artifact.id, "site");

    const evidence = reader.readEvidence(state.missionId, "site@1");
    assert.ok(evidence.some(item => item.kind === "file-integrity"));
    assert.ok(evidence.some(item => item.kind === "website-source"));
    const runtimeEvidence = evidence.find(item => item.kind === "browser-runtime");
    assert.ok(runtimeEvidence);
    assert.equal(runtimeEvidence?.collectorId, "host-evidence:website-browser-runtime");
    assert.equal(runtimeEvidence?.result, "supports");
    assert.equal((runtimeEvidence?.details as any).provider, "fixture-browser");
    assert.equal(JSON.stringify(runtimeEvidence).includes("blockingConsoleErrors"), false);
    assert.equal(JSON.stringify(runtimeEvidence).includes("keyboard-focus"), false);

    const hostReviewInput = transport.requests[0]?.input as any;
    const transientRuntime = hostReviewInput.runtimeEvidence.find((item: any) => item.kind === "browser-runtime");
    assert.equal(transientRuntime.inspectionPayload.evidence.blockingConsoleErrors, 0);
    assert.deepEqual(transientRuntime.inspectionPayload.evidence.interactions, ["primary-navigation", "keyboard-focus"]);

    const durableIds = evidence.map(item => item.id).sort();
    const second = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(second.overall, "pass");
    assert.equal(host.invocations.length, 2, "read-only runtime observation may be refreshed on retry");
    assert.deepEqual(
      reader.readEvidence(state.missionId, "site@1").map(item => item.id).sort(),
      durableIds,
      "byte-/claim-identical Evidence must remain durably idempotent"
    );
    const evidenceEvents = (await events.list(state.missionId)).filter(event => event.type === "evidence.collected");
    assert.equal(evidenceEvents.length, durableIds.length);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
