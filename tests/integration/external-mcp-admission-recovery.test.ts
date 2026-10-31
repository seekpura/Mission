import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
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
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";
import { ExternalMcpCatalogDiscoveryProvider } from "../../src/runtime/external-mcp-catalog.ts";
import {
  ExternalMcpAdmissionRuntime,
  MissionExternalMcpHostAdapter
} from "../../src/runtime/external-mcp-admission.ts";
import { TrustedMcpHostAdapter, TrustedMcpRegistry } from "../../src/runtime/trusted-mcp-runtime.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class MissingRuntime implements CapabilityRuntime {
  private readonly overlay: MissionCapabilityOverlay;

  constructor(overlay: MissionCapabilityOverlay) {
    this.overlay = overlay;
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    for (const capability of capabilities) {
      if (!capability.hostNative && capability.available) this.overlay.activate(missionId, capability);
    }
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.overlay.deactivate(missionId, capabilityId);
  }

  async ensure(): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "no existing capability" };
  }
}

class CaptureHost implements HostAdapter {
  readonly createRequests: AgentCreateRequest[] = [];
  async describeHost(): Promise<HostDescriptor> { return { type: "capture" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.createRequests.push(structuredClone(request));
    return { id: `handle-${this.createRequests.length}`, nativeRef: `native-${this.createRequests.length}` };
  }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "completed", payload: {}, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

const catalogEntries = [{
  id: "vendor-docs",
  name: "vendor_docs",
  description: "External vendor documentation MCP",
  revision: "2026-10-31.r1",
  url: "https://mcp.example.test/mcp",
  functions: ["search vendor docs"],
  accepts: ["query"],
  produces: ["documentation"]
}];

function need(): CapabilityNeed {
  return {
    id: "need-external-docs",
    missionId: "mission-external-mcp-admission",
    objective: "search vendor docs",
    requiredFunctions: ["search vendor docs"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "high",
    policy: { acceptableKinds: ["mcp"] },
    requirementRefs: [],
    gapRefs: []
  };
}

async function waitForPending(manager: RuntimeApprovalManager) {
  let records = await manager.listPending(need().missionId);
  for (let attempt = 0; records.length === 0 && attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    records = await manager.listPending(need().missionId);
  }
  return records;
}

function admission(
  approvals: RuntimeApprovalManager,
  overlay: MissionCapabilityOverlay
): ExternalMcpAdmissionRuntime {
  return new ExternalMcpAdmissionRuntime({
    base: new MissingRuntime(overlay),
    catalog: new ExternalMcpCatalogDiscoveryProvider(catalogEntries),
    approvals,
    revocations: { isCapabilityRevoked: () => false }
  });
}

function deliveryHost(capture: CaptureHost, overlay: MissionCapabilityOverlay): HostAdapter {
  return new TrustedMcpHostAdapter(
    new MissionExternalMcpHostAdapter(capture, overlay),
    new TrustedMcpRegistry([])
  );
}

test("external MCP approval is idempotent, non-deliverable before durable activation, and restart-recoverable", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  let approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });

  try {
    await controller.createMission(need().missionId, "prove durable external MCP admission");
    const firstOverlay = new MissionCapabilityOverlay();
    const firstRuntime = admission(approvals, firstOverlay);
    const firstEnsure = firstRuntime.ensure(need());
    const pending = await waitForPending(approvals);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "acquisition");
    assert.equal(pending[0]!.details.credentials, "none");
    assert.equal(pending[0]!.details.transport, "streamable-http-https");

    await approvals.decide(need().missionId, pending[0]!.id, {
      approved: true,
      scope: "once",
      actor: "user:test"
    });
    const first = await firstEnsure;
    assert.equal(first.status, "resolved");
    assert(first.capability);
    const capability = first.capability as CapabilityDescriptor;
    assert.equal(capability.id, "external-mcp:vendor-docs");
    assert.equal(capability.invocationRef, "https://mcp.example.test/mcp");
    assert.equal(capability.provenance?.source, "external");
    assert.equal(capability.native?.provider, "external-mcp");
    assert(capability.native?.features?.includes("no-credentials"));
    assert.equal(firstOverlay.list(need().missionId).length, 0, "approval alone must not mutate Mission activation state");

    const preActivationCapture = new CaptureHost();
    await assert.rejects(
      () => deliveryHost(preActivationCapture, firstOverlay).createAgent({
        missionId: need().missionId,
        workItemId: "work-before-activation",
        context: {},
        allowedCapabilityRefs: [capability.id]
      }),
      /not activated/i,
      "approval alone must not make an MCP deliverable before capability.activated becomes durable"
    );
    assert.equal(preActivationCapture.createRequests.length, 0);

    approvals.dispose();
    approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });
    const retryOverlay = new MissionCapabilityOverlay();
    const retryRuntime = admission(approvals, retryOverlay);
    const retry = await Promise.race([
      retryRuntime.ensure(need()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("approved external MCP retry prompted again")), 100))
    ]);
    assert.equal(retry.status, "resolved");
    assert.deepEqual(retry.capability, capability);

    const approvalEvents = (await events.list(need().missionId)).filter(event =>
      event.type === "approval.requested" || event.type === "approval.decided"
    );
    assert.equal(approvalEvents.filter(event => event.type === "approval.requested").length, 1);
    assert.equal(approvalEvents.filter(event => event.type === "approval.decided").length, 1);

    const expectedSequence = await events.lastSequence(need().missionId);
    await events.append({
      id: "external-mcp-activation-fixture",
      missionId: need().missionId,
      type: "capability.activated",
      actor: { type: "controller" },
      payload: {
        capabilityNeedId: need().id,
        capability,
        source: "acquired",
        reason: "approved external MCP fixture",
        attempts: []
      },
      idempotencyKey: `capability-activated:${need().id}:${capability.id}:${capability.revision}`,
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    }, expectedSequence);

    const journal = await reader.journal(need().missionId);
    assert.deepEqual(journal.capabilities.get(capability.id), capability);
    retryRuntime.restoreMissionCapabilities(need().missionId, journal.capabilities.values());

    const capture = new CaptureHost();
    await deliveryHost(capture, retryOverlay).createAgent({
      missionId: need().missionId,
      workItemId: "work-docs",
      context: {},
      allowedCapabilityRefs: [capability.id]
    });
    assert.deepEqual(capture.createRequests[0]?.mcpServers, [
      { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
    ]);

    const restartedOverlay = new MissionCapabilityOverlay();
    const restartedRuntime = admission(approvals, restartedOverlay);
    restartedRuntime.restoreMissionCapabilities(need().missionId, (await reader.journal(need().missionId)).capabilities.values());
    const restartedCapture = new CaptureHost();
    const restartedHost = deliveryHost(restartedCapture, restartedOverlay);
    await restartedHost.createAgent({
      missionId: need().missionId,
      workItemId: "work-after-restart",
      context: {},
      allowedCapabilityRefs: [capability.id]
    });
    assert.deepEqual(restartedCapture.createRequests[0]?.mcpServers, [
      { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
    ]);

    await assert.rejects(
      () => restartedHost.createAgent({
        missionId: need().missionId,
        workItemId: "work-direct-injection",
        context: {},
        allowedCapabilityRefs: [],
        mcpServers: [{ transport: "http", name: "bypass", url: "https://bypass.example.test/mcp", headers: [] }]
      }),
      /reserved for TrustedMcpHostAdapter delivery/
    );
    assert.equal(restartedCapture.createRequests.length, 1);
  } finally {
    approvals.dispose();
    database.close();
  }
});
