import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
} from "../../src/hosts/deepseek/host-adapter.ts";
import {
  TrustedMcpHostAdapter,
  TrustedMcpRegistry,
  parseTrustedMcpServersJson,
  type TrustedMcpServerConfig
} from "../../src/runtime/trusted-mcp-runtime.ts";

class RecordingHost implements HostAdapter {
  lastCreate?: AgentCreateRequest;
  lastResume?: AgentResumeRequest;

  async describeHost(): Promise<HostDescriptor> { return { type: "recording-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [{
        id: "recording-host.agent",
        kind: "agent",
        name: "Recording Host Agent",
        description: "Base host agent",
        hostNative: true,
        available: true,
        permissions: [],
        scope: "host"
      }],
      shellAvailable: false,
      filesystemAvailable: false,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.lastCreate = request;
    return { id: "recording-agent", nativeRef: "native-recording" };
  }
  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    this.lastResume = request;
    return { status: "resumed", handle: { id: request.handleId, nativeRef: request.nativeRef } };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {}
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: false }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

function configs(revision = "config-v1"): TrustedMcpServerConfig[] {
  return [
    {
      id: "trusted-mcp:local-tools",
      name: "local_tools",
      description: "Trusted local MCP tools for structured repository operations",
      revision,
      transport: "stdio",
      command: process.execPath,
      args: ["/absolute/mcp-server.mjs"],
      env: [{ name: "LOCAL_MCP_TOKEN", value: "local-fixture-secret" }]
    },
    {
      id: "trusted-mcp:research",
      name: "research",
      description: "Trusted HTTPS MCP research service for current source retrieval",
      revision: "research-v3",
      transport: "http",
      url: "https://mcp.example.test/api",
      headers: [{ name: "Authorization", value: "Bearer remote-fixture-secret" }]
    }
  ];
}

test("trusted MCP registry exposes only non-secret capabilities and delivers only Work-authorized servers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-trusted-mcp-"));
  try {
    const base = new RecordingHost();
    const registry = new TrustedMcpRegistry(configs());
    const host = new TrustedMcpHostAdapter(base, registry);
    const snapshot = await host.snapshotEnvironment();
    const serializedSnapshot = JSON.stringify(snapshot);

    assert.equal(snapshot.capabilities.some(capability => capability.id === "trusted-mcp:local-tools"), true);
    assert.equal(snapshot.capabilities.some(capability => capability.id === "trusted-mcp:research"), true);
    assert.equal(serializedSnapshot.includes("local-fixture-secret"), false);
    assert.equal(serializedSnapshot.includes("remote-fixture-secret"), false);
    assert.equal(snapshot.capabilities.find(capability => capability.id === "trusted-mcp:research")?.revision, "research-v3");

    const allowedWorkspace = join(root, "allowed");
    await mkdir(allowedWorkspace);
    await host.createAgent({
      missionId: "mission-trusted-mcp",
      workItemId: "work-research",
      context: { objective: "use research MCP only" },
      allowedCapabilityRefs: ["recording-host.agent", "trusted-mcp:research"],
      workspaceRoot: allowedWorkspace
    });
    assert.deepEqual(base.lastCreate?.mcpServers, [{
      transport: "http",
      name: "research",
      url: "https://mcp.example.test/api",
      headers: [{ name: "Authorization", value: "Bearer remote-fixture-secret" }]
    }]);
    const receiptText = readFileSync(join(allowedWorkspace, ".mission-mcp-projection.json"), "utf8");
    assert.equal(receiptText.includes("remote-fixture-secret"), false);
    assert.match(receiptText, /trusted-mcp:research/);
    assert.match(receiptText, /research-v3/);

    const deniedWorkspace = join(root, "denied");
    await mkdir(deniedWorkspace);
    await host.createAgent({
      missionId: "mission-trusted-mcp",
      workItemId: "work-without-mcp",
      context: {},
      allowedCapabilityRefs: ["recording-host.agent"],
      workspaceRoot: deniedWorkspace
    });
    assert.deepEqual(base.lastCreate?.mcpServers, []);

    const unknownWorkspace = join(root, "unknown");
    await mkdir(unknownWorkspace);
    await assert.rejects(
      host.createAgent({
        missionId: "mission-trusted-mcp",
        workItemId: "work-unknown-mcp",
        context: {},
        allowedCapabilityRefs: ["trusted-mcp:not-configured"],
        workspaceRoot: unknownWorkspace
      }),
      /Unknown trusted MCP capability reference/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted MCP recovery requires the same non-secret config revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-trusted-mcp-recovery-"));
  try {
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    const base = new RecordingHost();
    const first = new TrustedMcpHostAdapter(base, new TrustedMcpRegistry(configs("config-v1")));
    const handle = await first.createAgent({
      missionId: "mission-mcp-recovery",
      workItemId: "work-mcp-recovery",
      context: {},
      allowedCapabilityRefs: ["trusted-mcp:local-tools"],
      workspaceRoot: workspace
    });

    const resumed = await first.resumeAgent({
      missionId: "mission-mcp-recovery",
      workItemId: "work-mcp-recovery",
      context: {},
      allowedCapabilityRefs: ["trusted-mcp:local-tools"],
      workspaceRoot: workspace,
      handleId: handle.id,
      nativeRef: handle.nativeRef!
    });
    assert.equal(resumed.status, "resumed");
    assert.equal(base.lastResume?.mcpServers?.[0]?.name, "local_tools");

    const changed = new TrustedMcpHostAdapter(base, new TrustedMcpRegistry(configs("config-v2")));
    const rejected = await changed.resumeAgent({
      missionId: "mission-mcp-recovery",
      workItemId: "work-mcp-recovery",
      context: {},
      allowedCapabilityRefs: ["trusted-mcp:local-tools"],
      workspaceRoot: workspace,
      handleId: handle.id,
      nativeRef: handle.nativeRef!
    });
    assert.equal(rejected.status, "failed");
    if (rejected.status === "failed") assert.match(rejected.reason, /configuration\/revision changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("trusted MCP configuration fails closed for insecure HTTP and relative stdio commands", () => {
  assert.throws(() => new TrustedMcpRegistry([{
    id: "trusted-mcp:insecure",
    name: "insecure",
    description: "should be rejected",
    revision: "v1",
    transport: "http",
    url: "http://example.test/mcp"
  }]), /requires HTTPS/);

  assert.throws(() => new TrustedMcpRegistry([{
    id: "trusted-mcp:relative",
    name: "relative",
    description: "should be rejected",
    revision: "v1",
    transport: "stdio",
    command: "node",
    args: [],
    env: []
  }]), /command must be an absolute path/);
});

test("trusted MCP env parser validates at bootstrap and keeps secret values out of descriptors", () => {
  const json = JSON.stringify([{
    id: "trusted-mcp:api",
    name: "api",
    description: "Trusted HTTPS API MCP",
    revision: "2026-10-29",
    transport: "http",
    url: "https://mcp.example.test/v1",
    headers: [{ name: "Authorization", value: "Bearer bootstrap-secret" }]
  }]);
  const parsed = parseTrustedMcpServersJson(json);
  const registry = new TrustedMcpRegistry(parsed);
  assert.equal(parsed.length, 1);
  assert.equal(JSON.stringify(registry.capabilities()).includes("bootstrap-secret"), false);
});
