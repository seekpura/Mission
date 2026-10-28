import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import {
  HostAgentWorkExecutionDriver,
  HOST_AGENT_OUTPUT_MANIFEST
} from "../../src/execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

class WritingHost implements HostAdapter {
  readonly capabilities: CapabilityDescriptor[] = [];
  lastRequest?: AgentCreateRequest;
  private nextId = 1;
  private readonly manifestFactory: (workspaceRoot: string) => unknown;

  constructor(manifestFactory: (workspaceRoot: string) => unknown) {
    this.manifestFactory = manifestFactory;
  }

  async describeHost(): Promise<HostDescriptor> { return { type: "writing-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: this.capabilities,
      shellAvailable: true,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.lastRequest = request;
    if (!request.workspaceRoot) throw new Error("workspaceRoot required");
    const manifest = this.manifestFactory(request.workspaceRoot);
    writeFileSync(
      join(request.workspaceRoot, HOST_AGENT_OUTPUT_MANIFEST),
      JSON.stringify(manifest),
      "utf8"
    );
    return { id: `agent-${this.nextId++}` };
  }

  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "WritingHost has no durable native session" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    yield { type: "completed", payload: { stopReason: "end_turn" }, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: true }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: true, scope: "once" }; }
}

class HangingHost extends WritingHost {
  cancelled = false;

  constructor() {
    super(() => ({ outputs: [] }));
  }

  override async cancelAgent(_handle: HostAgentHandle): Promise<void> {
    this.cancelled = true;
  }

  override async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    await new Promise<void>(() => {});
  }
}

function executionInput() {
  return {
    state: {
      missionId: "mission-host-driver",
      status: "active" as const,
      revision: 7,
      missionSpecRevision: 1,
      acceptanceRevision: 1,
      strategyRevision: 1,
      graphRevision: 2,
      environmentSnapshotRevision: 0,
      activeWorkstreamIds: [],
      activeWorkItemIds: [],
      readyWorkItemIds: ["work-1"],
      blockedWorkItemIds: [],
      verifyingWorkItemIds: [],
      openGapIds: [],
      blockingGapIds: [],
      activeExecutionIds: [],
      pendingApprovalIds: [],
      finalArtifactRefs: [],
      lastEventSequence: 7
    },
    workItem: {
      id: "work-1",
      missionId: "mission-host-driver",
      purpose: "production" as const,
      objective: "produce the deliverable",
      status: "ready" as const,
      requirementRefs: ["req-1"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      priority: 1,
      graphRevision: 2,
      createdBy: "planner" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    contextPacket: {
      id: "context-1",
      missionId: "mission-host-driver",
      workItemId: "work-1",
      objective: "produce the deliverable",
      requirementRefs: ["req-1"],
      constraintRefs: [],
      truthRefs: [],
      sourceRefs: [],
      artifactRefs: [],
      decisionRefs: [],
      localAcceptanceCriteria: [],
      allowedCapabilityRefs: ["host.agent"],
      recentFailureRefs: [],
      contextVersion: 7,
      compilerManifest: {
        missionRevision: 7,
        graphRevision: 2,
        generatedAt: new Date().toISOString()
      }
    },
    attemptId: "attempt-1",
    executionId: "execution-1"
  };
}

test("HostAgentWorkExecutionDriver commits only manifest-declared workspace files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-host-driver-"));
  try {
    const host = new WritingHost(workspaceRoot => {
      mkdirSync(join(workspaceRoot, "out"), { recursive: true });
      writeFileSync(join(workspaceRoot, "out", "deliverable.txt"), "real artifact bytes", "utf8");
      return {
        outputs: [
          {
            path: "out/deliverable.txt",
            logicalName: "deliverable",
            type: "file",
            mimeType: "text/plain"
          }
        ]
      };
    });
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );

    const outcome = await driver.execute(executionInput());

    assert.equal(outcome.result.state, "succeeded");
    assert.deepEqual(outcome.result.committedArtifactRefs, ["deliverable@1"]);
    assert.equal(outcome.artifacts.length, 1);
    assert.equal(outcome.artifacts[0]?.logicalName, "deliverable");
    assert.equal(outcome.artifacts[0]?.status, "candidate");
    assert.equal(outcome.artifacts[0]?.sizeBytes, Buffer.byteLength("real artifact bytes"));
    assert.equal(host.lastRequest?.workspaceRoot !== undefined, true);
    assert.deepEqual(host.lastRequest?.allowedCapabilityRefs, ["host.agent"]);

    const contract = host.lastRequest?.context as any;
    assert.equal(contract.executionContract.outputManifest.path.endsWith(HOST_AGENT_OUTPUT_MANIFEST), true);
    assert.equal(contract.executionContract.expectedOutputs, undefined);
    assert.deepEqual(contract.executionContract.outputManifest.expectedOutputs, [
      { logicalName: "deliverable", type: "file", required: true }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HostAgentWorkExecutionDriver rejects output paths that escape the Mission workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-host-driver-escape-"));
  try {
    const host = new WritingHost(workspaceRoot => {
      writeFileSync(join(workspaceRoot, "..", "escape.txt"), "outside", "utf8");
      return {
        outputs: [{ path: "../escape.txt", logicalName: "deliverable", type: "file" }]
      };
    });
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );

    await assert.rejects(driver.execute(executionInput()), /escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HostAgentWorkExecutionDriver rejects symlink outputs that resolve outside the workspace", {
  skip: process.platform === "win32"
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-host-driver-symlink-"));
  try {
    const host = new WritingHost(workspaceRoot => {
      const outside = join(root, "outside.txt");
      writeFileSync(outside, "outside", "utf8");
      symlinkSync(outside, join(workspaceRoot, "linked.txt"));
      return {
        outputs: [{ path: "linked.txt", logicalName: "deliverable", type: "file" }]
      };
    });
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );

    await assert.rejects(driver.execute(executionInput()), /escapes workspace/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("HostAgentWorkExecutionDriver cancels and returns timed_out when a host never terminates", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-host-driver-timeout-"));
  try {
    const host = new HangingHost();
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store")),
      { hardTimeoutMs: 1_000 }
    );

    const outcome = await driver.execute(executionInput());
    assert.equal(outcome.result.state, "timed_out");
    assert.equal(host.cancelled, true);
    assert.deepEqual(outcome.artifacts, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
