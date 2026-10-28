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
} from "../../src/hosts/deepseek/host-adapter.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { HostAgentWorkExecutionDriver } from "../../src/execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

class SideEffectReceiptHost implements HostAdapter {
  lastRequest?: AgentCreateRequest;

  async describeHost(): Promise<HostDescriptor> { return { type: "side-effect-receipt-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: true,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.lastRequest = request;
    return { id: "agent-side-effect" };
  }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not needed" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    yield {
      type: "tool",
      payload: {
        sessionUpdate: "mission_side_effect_receipt",
        sideEffects: [
          {
            type: "external-write",
            target: "https://example.test/resource",
            reversible: true,
            result: "completed",
            intentId: "effect-1",
            operationKey: "op-1",
            effectClass: "external-write",
            status: "succeeded"
          }
        ]
      },
      at: new Date().toISOString()
    };
    yield { type: "completed", payload: { stopReason: "end_turn" }, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: true }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: true, scope: "once" }; }
}

function executionInput() {
  return {
    state: {
      missionId: "mission-side-effect-result",
      status: "active" as const,
      revision: 1,
      missionSpecRevision: 1,
      acceptanceRevision: 1,
      strategyRevision: 1,
      graphRevision: 1,
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
      lastEventSequence: 1
    },
    workItem: {
      id: "work-1",
      missionId: "mission-side-effect-result",
      purpose: "production" as const,
      objective: "exercise a side effect",
      status: "ready" as const,
      requirementRefs: [],
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
      id: "context-1",
      missionId: "mission-side-effect-result",
      workItemId: "work-1",
      objective: "exercise a side effect",
      requirementRefs: [],
      constraintRefs: [],
      truthRefs: [],
      sourceRefs: [],
      artifactRefs: [],
      decisionRefs: [],
      localAcceptanceCriteria: [],
      allowedCapabilityRefs: ["host.agent"],
      recentFailureRefs: [],
      contextVersion: 1,
      compilerManifest: {
        missionRevision: 1,
        graphRevision: 1,
        generatedAt: new Date().toISOString()
      }
    },
    attemptId: "attempt-side-effect-1",
    executionId: "execution-side-effect-1"
  };
}

test("HostAgentWorkExecutionDriver propagates runtime identity and side-effect receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-host-side-effect-result-"));
  try {
    const host = new SideEffectReceiptHost();
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );

    const outcome = await driver.execute(executionInput());

    assert.equal(host.lastRequest?.attemptId, "attempt-side-effect-1");
    assert.equal(host.lastRequest?.executionId, "execution-side-effect-1");
    assert.equal(outcome.result.state, "succeeded");
    assert.deepEqual(outcome.result.sideEffects, [
      {
        type: "external-write",
        target: "https://example.test/resource",
        reversible: true,
        result: "completed",
        intentId: "effect-1",
        operationKey: "op-1",
        effectClass: "external-write",
        status: "succeeded"
      }
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
