import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
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
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";
import { ExternalMcpCatalogDiscoveryProvider } from "../../src/runtime/external-mcp-catalog.ts";
import {
  ExternalMcpAdmissionRuntime,
  MissionExternalMcpHostAdapter,
  MissionExternalMcpRegistry
} from "../../src/runtime/external-mcp-admission.ts";
import { TrustedMcpHostAdapter, TrustedMcpRegistry } from "../../src/runtime/trusted-mcp-runtime.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class MissingRuntime implements CapabilityRuntime {
  restoreMissionCapabilities(): void {}
  deactivateMissionCapability(): void {}
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
  registry: MissionExternalMcpRegistry
): ExternalMcpAdmissionRuntime {
  return new ExternalMcpAdmissionRuntime({
    base: new MissingRuntime(),
    catalog: new ExternalMcpCatalogDiscoveryProvider(catalogEntries),
    approvals,
    registry
  });
}

test("external MCP approval is idempotent, non-deliverable before durable activation, and restart-recoverable", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  let approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });

  try {
    await controller.createMission(need().missionId, "prove durable external MCP admission");
    const firstRegistry = new MissionExternalMcpRegistry();
    const firstRuntime = admission(approvals, firstRegistry);
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

    assert.throws(
      () => firstRegistry.select(need().missionId, [capability.id]),
      /not activated/i,
      "approval alone must not make an MCP deliverable before capability.activated becomes durable"
    );

    approvals.dispose();
    approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });
    const retryRegistry = new MissionExternalMcpRegistry();
    const retry = await Promise.race([
      admission(approvals, retryRegistry).ensure(need()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("approved external MCP retry prompted again")), 100))
    ]);
    assert.equal(retry.status, "resolved");
    assert.deepEqual(retry.capability, capability);
    assert.equal(
      (await events.list(need().missionId)).filter(event => event.type === "approval.requested").length,
      1,
      "retry after approval but before durable activation must reuse the same acquisition approval"
    );

    retryRegistry.restoreMissionCapabilities(need().missionId, [capability]);
    const capture = new CaptureHost();
    const host = new TrustedMcpHostAdapter(
      new MissionExternalMcpHostAdapter(capture, retryRegistry),
      new TrustedMcpRegistry([])
    );
    await host.createAgent({
      missionId: need().missionId,
      workItemId: "work-docs",
      context: {},
      allowedCapabilityRefs: [capability.id]
    });
    assert.deepEqual(capture.createRequests[0]?.mcpServers, [
      { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
    ]);

    const restartedRegistry = new MissionExternalMcpRegistry();
    restartedRegistry.restoreMissionCapabilities(need().missionId, [structuredClone(capability)]);
    const restartedCapture = new CaptureHost();
    const restartedHost = new TrustedMcpHostAdapter(
      new MissionExternalMcpHostAdapter(restartedCapture, restartedRegistry),
      new TrustedMcpRegistry([])
    );
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
