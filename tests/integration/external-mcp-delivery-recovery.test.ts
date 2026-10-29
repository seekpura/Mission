import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { AcquisitionReceipt, AcquisitionReceiptStore } from "../../src/core/capabilities/acquisition-receipt.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
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
  HostDescriptor,
  HostMcpServer
} from "../../src/hosts/host-adapter.ts";
import {
  ExternalMcpAcquirer,
  ExternalMcpCapabilityRuntime,
  ExternalMcpCatalog,
  MissionExternalMcpHostAdapter,
  MissionExternalMcpRegistry
} from "../../src/runtime/external-mcp-runtime.ts";
import { TrustedMcpHostAdapter, TrustedMcpRegistry } from "../../src/runtime/trusted-mcp-runtime.ts";

class Receipts implements AcquisitionReceiptStore {
  readonly values: AcquisitionReceipt[] = [];
  save(receipt: AcquisitionReceipt): void { this.values.push(structuredClone(receipt)); }
  list(missionId: string): AcquisitionReceipt[] { return this.values.filter(value => value.missionId === missionId); }
}

class MissingRuntime implements CapabilityRuntime {
  restoreMissionCapabilities(): void {}
  deactivateMissionCapability(): void {}
  async ensure(): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "missing" };
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
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> { return { status: "unsupported", reason: "not used" }; }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> { yield { type: "completed", payload: {}, at: new Date().toISOString() }; }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: false, error: "not used" }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

const catalogEntries = [{
  id: "vendor-docs",
  name: "vendor_docs",
  description: "External vendor docs MCP",
  revision: "r17",
  url: "https://mcp.example.test/mcp",
  functions: ["search vendor docs"],
  accepts: ["query"],
  produces: ["documentation"]
}];

function need(): CapabilityNeed {
  return {
    id: "need-external-docs",
    missionId: "mission-external-delivery",
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

async function acquire(registry: MissionExternalMcpRegistry): Promise<CapabilityDescriptor> {
  const catalog = new ExternalMcpCatalog(catalogEntries);
  const acquirer = new ExternalMcpAcquirer({
    catalog,
    registry,
    receipts: new Receipts(),
    approvals: { async requestApproval() { return { approved: true, actor: "test-user" }; } }
  });
  const runtime = new ExternalMcpCapabilityRuntime({ base: new MissingRuntime(), catalog, acquirer, registry });
  const result = await runtime.ensure(need());
  assert.equal(result.status, "resolved");
  assert(result.capability);
  return result.capability;
}

test("approved external MCP merges with host-trusted MCP only after durable capability restoration", async () => {
  const registry = new MissionExternalMcpRegistry();
  const capability = await acquire(registry);
  const capture = new CaptureHost();
  const host = new TrustedMcpHostAdapter(
    new MissionExternalMcpHostAdapter(capture, registry),
    new TrustedMcpRegistry([{
      id: "trusted-mcp:internal-docs",
      name: "internal_docs",
      description: "Operator trusted docs",
      revision: "trusted-r1",
      transport: "http",
      url: "https://internal.example.test/mcp"
    }])
  );

  // Acquisition alone is not the durable authority. Simulate the controller's
  // capability.activated projection/restoration boundary before Work delivery.
  registry.restoreMissionCapabilities(need().missionId, [capability]);
  await host.createAgent({
    missionId: need().missionId,
    workItemId: "work-docs",
    context: {},
    workspaceRoot: "/tmp/work-docs",
    allowedCapabilityRefs: ["trusted-mcp:internal-docs", capability.id]
  });

  const delivered = capture.createRequests[0]?.mcpServers as HostMcpServer[];
  assert.deepEqual(delivered, [
    { transport: "http", name: "internal_docs", url: "https://internal.example.test/mcp", headers: [] },
    { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
  ]);
});

test("restart can rebuild external MCP delivery solely from the durable non-secret capability descriptor", async () => {
  const initialRegistry = new MissionExternalMcpRegistry();
  const capability = await acquire(initialRegistry);

  const restartedRegistry = new MissionExternalMcpRegistry();
  restartedRegistry.restoreMissionCapabilities(need().missionId, [structuredClone(capability)]);
  const capture = new CaptureHost();
  const host = new TrustedMcpHostAdapter(
    new MissionExternalMcpHostAdapter(capture, restartedRegistry),
    new TrustedMcpRegistry([])
  );
  await host.createAgent({
    missionId: need().missionId,
    workItemId: "work-after-restart",
    context: {},
    workspaceRoot: "/tmp/work-after-restart",
    allowedCapabilityRefs: [capability.id]
  });
  assert.deepEqual(capture.createRequests[0]?.mcpServers, [
    { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
  ]);
});

test("direct caller MCP injection is still rejected by the outer trusted delivery boundary", async () => {
  const registry = new MissionExternalMcpRegistry();
  const capture = new CaptureHost();
  const host = new TrustedMcpHostAdapter(
    new MissionExternalMcpHostAdapter(capture, registry),
    new TrustedMcpRegistry([])
  );
  await assert.rejects(
    () => host.createAgent({
      missionId: need().missionId,
      workItemId: "work-direct-injection",
      context: {},
      allowedCapabilityRefs: [],
      mcpServers: [{ transport: "http", name: "bypass", url: "https://bypass.example.test/mcp", headers: [] }]
    }),
    /Direct mcpServers are not accepted/
  );
  assert.equal(capture.createRequests.length, 0);
});
