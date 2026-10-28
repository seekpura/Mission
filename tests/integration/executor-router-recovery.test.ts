import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionResult, ExecutionRuntimeBinding } from "../../src/core/domain/execution.ts";
import type { WorkExecutionDriver, WorkExecutionInput, WorkRecoveryInput } from "../../src/core/execution/work-execution-driver.ts";
import { ExecutorRouter } from "../../src/core/execution/executor-router.ts";

class RouteDriver implements WorkExecutionDriver {
  readonly id = "shared-host-driver";
  readonly label: string;
  executeCalls = 0;
  recoverCalls = 0;

  constructor(label: string) {
    this.label = label;
  }

  async execute(input: WorkExecutionInput) {
    this.executeCalls += 1;
    await input.lifecycle?.bindRuntime(binding(input, this.id));
    return emptySuccess(input.executionId);
  }

  async recover(input: WorkRecoveryInput) {
    this.recoverCalls += 1;
    return emptySuccess(input.executionId);
  }
}

function binding(input: WorkExecutionInput, driverId: string): ExecutionRuntimeBinding {
  return {
    executionId: input.executionId,
    attemptId: input.attemptId,
    workItemId: input.workItem.id,
    driverId,
    hostHandleId: `handle:${input.executionId}`,
    nativeRef: `native:${input.executionId}`,
    workspaceRoot: `/tmp/${input.executionId}`,
    boundAt: new Date().toISOString()
  };
}

function emptySuccess(executionId: string) {
  const now = new Date().toISOString();
  const result: ExecutionResult = {
    executionId,
    state: "succeeded",
    producedFiles: [],
    committedArtifactRefs: [],
    sideEffects: [],
    startedAt: now,
    endedAt: now
  };
  return { result, artifacts: [] };
}

function input(): WorkExecutionInput {
  return {
    state: {
      missionId: "mission-route-recovery",
      status: "active",
      revision: 1,
      missionSpecRevision: 1,
      acceptanceRevision: 1,
      strategyRevision: null,
      graphRevision: 1,
      environmentSnapshotRevision: 0,
      activeWorkstreamIds: [],
      activeWorkItemIds: [],
      readyWorkItemIds: ["work-route"],
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
      id: "work-route",
      missionId: "mission-route-recovery",
      purpose: "production",
      objective: "stay on the assigned executor route",
      status: "ready",
      requirementRefs: ["req-route"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      assignedExecutorId: "host-b",
      priority: 1,
      graphRevision: 1,
      createdBy: "planner",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    contextPacket: {
      id: "context-route",
      missionId: "mission-route-recovery",
      workItemId: "work-route",
      objective: "stay on the assigned executor route",
      requirementRefs: ["req-route"],
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
    attemptId: "attempt-route",
    executionId: "execution-route"
  };
}

test("ExecutorRouter persists route identity and recovers through that exact route", async () => {
  const a = new RouteDriver("a");
  const b = new RouteDriver("b");
  const router = new ExecutorRouter([
    { executorId: "host-a", driver: a },
    { executorId: "host-b", driver: b }
  ]);
  let captured: ExecutionRuntimeBinding | undefined;
  const executionInput = input();

  await router.execute({
    ...executionInput,
    lifecycle: { bindRuntime(value) { captured = value; } }
  });

  assert.equal(a.executeCalls, 0);
  assert.equal(b.executeCalls, 1);
  assert.equal(captured?.routeId, "host-b");
  assert.equal(captured?.driverId, "shared-host-driver");

  await router.recover({
    state: executionInput.state,
    workItem: executionInput.workItem,
    contextPacket: executionInput.contextPacket,
    attemptId: executionInput.attemptId,
    executionId: executionInput.executionId,
    binding: captured!
  });

  assert.equal(a.recoverCalls, 0);
  assert.equal(b.recoverCalls, 1);
});
