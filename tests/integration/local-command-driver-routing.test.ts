import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  SideEffectAdmission,
  SideEffectCompletion,
  SideEffectIntent,
  SideEffectPolicy
} from "../../src/core/domain/execution.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../src/core/execution/work-execution-driver.ts";
import { ExecutorRouter } from "../../src/core/execution/executor-router.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import {
  LocalCommandWorkExecutionDriver,
  type LocalCommandSideEffectBoundary
} from "../../src/execution/local/local-command-work-execution-driver.ts";
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

class RecordingLocalSideEffects implements LocalCommandSideEffectBoundary {
  readonly intents: SideEffectIntent[] = [];
  readonly policies: SideEffectPolicy[] = [];
  readonly completions: SideEffectCompletion[] = [];
  status: SideEffectAdmission["status"] = "admitted";

  async authorize(intent: SideEffectIntent, policy: SideEffectPolicy) {
    this.intents.push(intent);
    this.policies.push({ ...policy });
    return {
      intent,
      admission: {
        intentId: intent.id,
        operationKey: intent.operationKey,
        status: this.status,
        reason: this.status === "admitted" ? "test admission" : "test denial",
        approvalRequired: true,
        decidedAt: new Date().toISOString()
      }
    };
  }

  async complete(
    intent: SideEffectIntent,
    status: SideEffectCompletion["status"],
    detail?: string
  ): Promise<SideEffectCompletion> {
    const completion: SideEffectCompletion = {
      intentId: intent.id,
      operationKey: intent.operationKey,
      status,
      ...(detail ? { detail } : {}),
      completedAt: new Date().toISOString()
    };
    this.completions.push(completion);
    return completion;
  }
}

test("LocalCommandWorkExecutionDriver durably admits trusted host-process execution and returns its side-effect receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-driver-"));
  try {
    const backend = new LocalExecutionBackend(
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    const sideEffects = new RecordingLocalSideEffects();
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
    }, sideEffects);

    const outcome = await driver.execute(executionInput("local"));
    assert.equal(outcome.result.state, "succeeded");
    assert.deepEqual(outcome.result.committedArtifactRefs, ["result@1"]);
    assert.equal(outcome.artifacts.length, 1);
    assert.equal(outcome.artifacts[0]?.logicalName, "result");
    assert.equal(outcome.artifacts[0]?.producedByAttemptId, "attempt-1");
    assert.equal(sideEffects.intents.length, 1);
    assert.equal(sideEffects.intents[0]?.source, "local-command");
    assert.equal(sideEffects.intents[0]?.effectClass, "unknown-effect");
    assert.equal(sideEffects.intents[0]?.type, "system-change");
    assert.equal(sideEffects.policies[0]?.idempotencyRequired, true);
    assert.equal(sideEffects.completions[0]?.status, "succeeded");
    assert.deepEqual(outcome.result.sideEffects, [
      {
        type: "system-change",
        target: sideEffects.intents[0]?.target,
        reversible: false,
        result: "succeeded",
        intentId: sideEffects.intents[0]?.id,
        operationKey: sideEffects.intents[0]?.operationKey,
        effectClass: "unknown-effect",
        status: "succeeded"
      }
    ]);
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
    const sideEffects = new RecordingLocalSideEffects();
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
    }, sideEffects);

    await assert.rejects(driver.execute(executionInput("local")), /trusted-host-process admission/);
    assert.equal(sideEffects.intents.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("LocalCommandWorkExecutionDriver never spawns a local process when side-effect admission is denied", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-driver-denied-"));
  try {
    const marker = join(root, "must-not-exist.txt");
    const backend = new LocalExecutionBackend(
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    const sideEffects = new RecordingLocalSideEffects();
    sideEffects.status = "denied";
    const driver = new LocalCommandWorkExecutionDriver(backend, {
      async plan() {
        return {
          trust: "trusted-host-process",
          rationale: "denial test",
          command: process.execPath,
          args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)},'should not run')`],
          outputFiles: []
        };
      }
    }, sideEffects);

    const outcome = await driver.execute(executionInput("local"));
    assert.equal(outcome.result.state, "failed");
    assert.equal(existsSync(marker), false);
    assert.equal(sideEffects.completions.length, 0);
    assert.equal(outcome.result.sideEffects[0]?.status, "denied");
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
