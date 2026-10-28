import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../src/core/execution/work-execution-driver.ts";
import { ExecutorRouter } from "../../src/core/execution/executor-router.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { LocalCommandWorkExecutionDriver } from "../../src/execution/local/local-command-work-execution-driver.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

function executionInput(assignedExecutorId?: string): WorkExecutionInput {
  const now = new Date().toISOString();
  return {
    state: {
      missionId: "mission-routing",
      status: "active",
      revision: 3,
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
      lastEventSequence: 3,
      createdAt: now,
      updatedAt: now
    },
    workItem: {
      id: "work-1",
      missionId: "mission-routing",
      purpose: "production",
      objective: "produce a trusted local artifact",
      status: "ready",
      requirementRefs: ["req-1"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "result", type: "document", required: true }],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      ...(assignedExecutorId ? { assignedExecutorId } : {}),
      priority: 1,
      graphRevision: 1,
      createdBy: "planner",
      createdAt: now,
      updatedAt: now
    },
    contextPacket: {
      id: "context-1",
      missionId: "mission-routing",
      workItemId: "work-1",
      objective: "produce a trusted local artifact",
      requirementRefs: ["req-1"],
      constraintRefs: [],
      truthRefs: [],
      sourceRefs: [],
      artifactRefs: [],
      decisionRefs: [],
      localAcceptanceCriteria: [],
      allowedCapabilityRefs: [],
      recentFailureRefs: [],
      contextVersion: 3,
      compilerManifest: {
        missionRevision: 3,
        graphRevision: 1,
        generatedAt: now
      }
    },
    attemptId: "attempt-1",
    executionId: "execution-1"
  };
}

test("LocalCommandWorkExecutionDriver runs only an explicitly trusted host-process plan and returns Artifact entities", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-driver-"));
  try {
    const backend = new LocalExecutionBackend(
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    const driver = new LocalCommandWorkExecutionDriver(backend, {
      async plan() {
        return {
          trust: "trusted-host-process",
          rationale: "CI-owned Node process used to validate the local execution adapter",
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('result.txt','local driver output')"],
          outputFiles: [{ path: "result.txt", logicalName: "result", type: "document" }],
          hardTimeoutMs: 5_000
        };
      }
    });

    const outcome = await driver.execute(executionInput("local"));
    assert.equal(outcome.result.state, "succeeded");
    assert.deepEqual(outcome.result.committedArtifactRefs, ["result@1"]);
    assert.equal(outcome.artifacts.length, 1);
    assert.equal(outcome.artifacts[0]?.logicalName, "result");
    assert.equal(outcome.artifacts[0]?.producedByAttemptId, "attempt-1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalCommandWorkExecutionDriver rejects plans without explicit trusted-host-process admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-driver-trust-"));
  try {
    const backend = new LocalExecutionBackend(
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    const driver = new LocalCommandWorkExecutionDriver(backend, {
      async plan() {
        return {
          trust: "untrusted" as any,
          rationale: "not admitted",
          command: process.execPath,
          args: [],
          outputFiles: []
        };
      }
    });

    await assert.rejects(driver.execute(executionInput("local")), /trusted-host-process admission/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

class RecordingDriver implements WorkExecutionDriver {
  calls = 0;
  readonly id: string;

  constructor(id: string) {
    this.id = id;
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    this.calls += 1;
    const now = new Date().toISOString();
    return {
      result: {
        executionId: input.executionId,
        state: "succeeded",
        producedFiles: [],
        committedArtifactRefs: [],
        sideEffects: [],
        startedAt: now,
        endedAt: now
      },
      artifacts: []
    };
  }
}

test("ExecutorRouter uses explicit assignedExecutorId and never guesses across multiple routes", async () => {
  const host = new RecordingDriver("host-driver");
  const local = new RecordingDriver("local-driver");
  const router = new ExecutorRouter([
    { executorId: "host", driver: host },
    { executorId: "local", driver: local }
  ]);

  await router.execute(executionInput("local"));
  assert.equal(local.calls, 1);
  assert.equal(host.calls, 0);

  await assert.rejects(
    router.execute(executionInput()),
    /no assignedExecutorId and multiple executor routes are available/
  );
});

test("ExecutorRouter supports an explicit default route", async () => {
  const host = new RecordingDriver("host-driver");
  const local = new RecordingDriver("local-driver");
  const router = new ExecutorRouter([
    { executorId: "host", driver: host },
    { executorId: "local", driver: local }
  ], { defaultExecutorId: "host" });

  await router.execute(executionInput());
  assert.equal(host.calls, 1);
  assert.equal(local.calls, 0);
});
