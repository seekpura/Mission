import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { createMissionRuntime } from "../../src/runtime/bootstrap.ts";
import { MISSION_JSON_BEGIN, MISSION_JSON_END } from "../../src/runtime/host-agent-json-transport.ts";

const missionId = "mission-production-external-mcp";
const capabilityId = "external-mcp:vendor-docs";

class ExternalMcpBootstrapHost implements HostAdapter {
  readonly createRequests: AgentCreateRequest[] = [];
  private readonly events = new Map<string, HostAgentEvent[]>();
  private nextId = 1;

  async describeHost(): Promise<HostDescriptor> {
    return { type: "external-mcp-bootstrap-test", version: "1" };
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [{
        id: "test.agent",
        kind: "agent",
        name: "Test Agent",
        description: "Generic host agent",
        hostNative: true,
        available: true,
        invocationRef: "test-agent",
        permissions: ["host-agent-session"],
        scope: "host"
      }],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.createRequests.push(structuredClone(request));
    const handle = { id: `external-mcp-host-${this.nextId++}`, nativeRef: `native-${this.nextId}` };
    const now = new Date().toISOString();
    if (request.workItemId.startsWith("control:")) {
      const response = controlResponse(request.workItemId);
      this.events.set(handle.id, [
        { type: "started", payload: { role: "control" }, at: now },
        {
          type: "message",
          payload: { content: { type: "text", text: `${MISSION_JSON_BEGIN}\n${JSON.stringify(response)}\n${MISSION_JSON_END}` } },
          at: now
        },
        { type: "completed", payload: { stopReason: "end_turn" }, at: now }
      ]);
      return handle;
    }

    this.events.set(handle.id, [
      { type: "started", payload: { role: "worker" }, at: now },
      { type: "completed", payload: { stopReason: "end_turn" }, at: now }
    ]);
    return handle;
  }

  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used" };
  }

  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const events = this.events.get(handle.id);
    if (!events) throw new Error(`Unknown test handle: ${handle.id}`);
    for (const event of events) yield event;
  }

  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }

  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

function controlResponse(workItemId: string): unknown {
  if (workItemId.startsWith("control:strategy-")) {
    return {
      framing: "use explicitly admitted external documentation capability",
      approach: "resolve one blocking capability then execute one work item",
      workstreams: [{ id: "research", objective: "search vendor documentation" }],
      revision: 1
    };
  }
  if (workItemId.startsWith("control:frontier-")) {
    return {
      graphRevision: 1,
      capabilityNeeds: [{
        id: "need-vendor-docs",
        objective: "search vendor docs",
        requiredFunctions: ["search vendor docs"],
        desiredInputs: ["query"],
        desiredOutputs: ["documentation"],
        purpose: "research",
        urgency: "blocking",
        acquisitionAllowed: true,
        maxRisk: "high",
        requirementRefs: [],
        gapRefs: []
      }],
      workItems: [{
        id: "use-vendor-docs",
        workstreamId: "research",
        purpose: "production",
        objective: "search vendor docs",
        requirementRefs: [],
        gapRefs: [],
        inputArtifactRefs: [],
        expectedOutputs: [],
        localAcceptanceCriteria: [],
        capabilityNeedRefs: ["need-vendor-docs"],
        priority: 100
      }]
    };
  }
  if (workItemId.startsWith("control:completion-")) {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
  throw new Error(`Unexpected control request: ${workItemId}`);
}

async function waitForPending(runtime: ReturnType<typeof createMissionRuntime>) {
  let records = await runtime.approvals.listPending(missionId);
  for (let attempt = 0; records.length === 0 && attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    records = await runtime.approvals.listPending(missionId);
  }
  return records;
}

test("production runtime admits external MCP durably before injecting it into Worker host delivery", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-external-mcp-bootstrap-"));
  const baseHost = new ExternalMcpBootstrapHost();
  const runtime = createMissionRuntime({
    rootDir: root,
    schemaPath: join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"),
    host: baseHost,
    executorId: "external-mcp-test-host",
    externalMcpCatalog: [{
      id: "vendor-docs",
      name: "vendor_docs",
      description: "External vendor documentation MCP",
      revision: "2026-10-31.r1",
      url: "https://mcp.example.test/mcp",
      functions: ["search vendor docs"],
      accepts: ["query"],
      produces: ["documentation"]
    }]
  });

  try {
    await runtime.controller.createMission(missionId, "search vendor documentation through an admitted MCP");
    const cycle = runtime.controller.runControllerCycle({ missionId, trigger: "mission_created" });

    const pending = await waitForPending(runtime);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, "acquisition");
    assert.equal(pending[0]!.details.registryId, "vendor-docs");
    assert.equal(pending[0]!.details.credentials, "none");

    const workerBeforeApproval = baseHost.createRequests.find(request => request.workItemId === "use-vendor-docs");
    assert.equal(workerBeforeApproval, undefined, "Worker must not start before external MCP approval and durable activation");

    await runtime.approvals.decide(missionId, pending[0]!.id, {
      approved: true,
      scope: "once",
      actor: "user:test"
    });
    await cycle;

    const worker = baseHost.createRequests.find(request => request.workItemId === "use-vendor-docs");
    assert(worker, "approved capability-backed work should reach the configured HostAdapter");
    assert.deepEqual(worker.allowedCapabilityRefs, [capabilityId]);
    assert.deepEqual(worker.mcpServers, [
      { transport: "http", name: "vendor_docs", url: "https://mcp.example.test/mcp", headers: [] }
    ]);

    const events = await runtime.events.list(missionId);
    const types = events.map(event => event.type);
    const requested = types.indexOf("approval.requested");
    const decided = types.indexOf("approval.decided");
    const activated = types.indexOf("capability.activated");
    const attempt = types.indexOf("attempt.created");
    assert.ok(requested >= 0 && requested < decided);
    assert.ok(decided < activated, "durable user approval must precede capability activation");
    assert.ok(activated < attempt, "capability.activated must be durable before Worker attempt creation");

    const activation = events.find(event => event.type === "capability.activated");
    assert.equal((activation?.payload as any)?.capability?.id, capabilityId);
    assert.equal((activation?.payload as any)?.capability?.provenance?.source, "external");
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});