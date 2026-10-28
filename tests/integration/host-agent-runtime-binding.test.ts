import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionRuntimeBinding } from "../../src/core/domain/execution.ts";
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
import { HostAgentWorkExecutionDriver } from "../../src/execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

class BindingHost implements HostAdapter {
  bindingVisible = false;
  observationStarted = false;
  private release!: () => void;
  private readonly released = new Promise<void>(resolve => { this.release = resolve; });

  async describeHost(): Promise<HostDescriptor> { return { type: "binding-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: false,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> {
    return { id: "host-handle-binding", nativeRef: "native-binding-session" };
  }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used by this test" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> { this.release(); }
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    this.observationStarted = true;
    assert.equal(this.bindingVisible, true, "runtime binding must be durable before host observation begins");
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    await this.released;
    yield { type: "completed", payload: {}, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: true }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: true, scope: "once" }; }
  finish() { this.release(); }
}

function input() {
  return {
    state: {
      missionId: "mission-binding",
      status: "active" as const,
      revision: 1,
      missionSpecRevision: 1,
      acceptanceRevision: 1,
      strategyRevision: null,
      graphRevision: 1,
      environmentSnapshotRevision: 0,
      activeWorkstreamIds: [],
      activeWorkItemIds: [],
      readyWorkItemIds: ["work-binding"],
      blockedWorkItemIds: [],
      verifyingWorkItemIds: [],
      openGapIds: [],
      blockingGapIds: [],
      activeExecutionIds: [],
      pendingApprovalIds: [],
      finalArtifactRefs: [],
      lastEventSequence: 1
    },
    workItem: {
      id: "work-binding",
      missionId: "mission-binding",
      purpose: "production" as const,
      objective: "prove runtime binding",
      status: "ready" as const,
      requirementRefs: ["req-binding"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      priority: 1,
      graphRevision: 1,
      createdBy: "planner" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    contextPacket: {
      id: "context-binding",
      missionId: "mission-binding",
      workItemId: "work-binding",
      objective: "prove runtime binding",
      requirementRefs: ["req-binding"],
      constraintRefs: [],
      truthRefs: [],
      sourceRefs: [],
      artifactRefs: [],
      decisionRefs: [],
      localAcceptanceCriteria: [],
      allowedCapabilityRefs: [],
      recentFailureRefs: [],
      contextVersion: 1,
      compilerManifest: { missionRevision: 1, graphRevision: 1, generatedAt: new Date().toISOString() }
    },
    attemptId: "attempt-binding",
    executionId: "execution-binding"
  };
}

test("HostAgentWorkExecutionDriver binds native runtime before observation and reports in-process ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-runtime-binding-"));
  const host = new BindingHost();
  let binding: ExecutionRuntimeBinding | undefined;
  const driver = new HostAgentWorkExecutionDriver(
    host,
    new WorkspaceManager(join(root, "workspaces")),
    new FileArtifactStore(join(root, "artifacts")),
    { hardTimeoutMs: 5_000 }
  );

  try {
    const execution = driver.execute({
      ...input(),
      lifecycle: {
        bindRuntime(value) {
          binding = value;
          host.bindingVisible = true;
        }
      }
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(driver.isActive("execution-binding"), true);
    assert.equal(host.observationStarted, true);
    assert.equal(binding?.executionId, "execution-binding");
    assert.equal(binding?.hostHandleId, "host-handle-binding");
    assert.equal(binding?.nativeRef, "native-binding-session");
    assert.equal(binding?.driverId, driver.id);

    host.finish();
    const outcome = await execution;
    assert.equal(outcome.result.state, "succeeded");
    assert.equal(driver.isActive("execution-binding"), false);
  } finally {
    host.finish();
    await rm(root, { recursive: true, force: true });
  }
});
