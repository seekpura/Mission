import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { activeExecutions } from "../../src/core/execution/recovery-view.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { ExecutionResult, ExecutionRuntimeBinding } from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { VerificationResult } from "../../src/core/domain/verification.ts";
import type { WorkExecutionDriver, WorkRecoveryInput } from "../../src/core/execution/work-execution-driver.ts";
import type { Verifier } from "../../src/core/verification/verifier.ts";

function database() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  return { db, store: new SqliteEventStore(db) };
}

function work(missionId: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: "recover-work",
    missionId,
    purpose: "production",
    objective: "finish the interrupted deliverable",
    status: "ready",
    requirementRefs: ["req-recovery"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: 100,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function recoveredArtifact(missionId: string, attemptId: string): Artifact {
  return {
    id: "deliverable",
    missionId,
    logicalName: "deliverable",
    type: "file",
    version: 1,
    status: "candidate",
    uri: "memory://recovered-deliverable",
    contentHash: "sha256:recovered",
    producedByAttemptId: attemptId,
    sourceArtifactRefs: [],
    createdAt: new Date().toISOString()
  };
}

class RecoveryDriver implements WorkExecutionDriver {
  readonly id = "recovery-driver";
  executeCalls = 0;
  recoverCalls = 0;
  lastRecovery?: WorkRecoveryInput;

  async execute(): Promise<never> {
    this.executeCalls += 1;
    throw new Error("restart recovery must not create a second execution");
  }

  isActive(): boolean { return false; }

  async recover(input: WorkRecoveryInput) {
    this.recoverCalls += 1;
    this.lastRecovery = input;
    const artifact = recoveredArtifact(input.workItem.missionId, input.attemptId);
    const now = new Date().toISOString();
    const result: ExecutionResult = {
      executionId: input.executionId,
      state: "succeeded",
      producedFiles: [{ path: artifact.uri, logicalName: artifact.logicalName, type: artifact.type }],
      committedArtifactRefs: [`${artifact.id}@${artifact.version}`],
      sideEffects: [],
      startedAt: now,
      endedAt: now
    };
    return { result, artifacts: [artifact] };
  }
}

class RecoveryVerifier implements Verifier {
  readonly id = "recovery-verifier";
  async verify(artifact: Artifact): Promise<VerificationResult> {
    return {
      id: `verify:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "recovery-mission-profile",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{ id: "recovered-artifact", status: "pass", evidenceRefs: ["evidence:recovery"] }],
      findingRefs: [],
      evidenceRefs: ["evidence:recovery"],
      createdAt: new Date().toISOString()
    };
  }
}

async function seedBoundExecution(
  controller: MissionController,
  missionId: string,
  includeBinding = true
): Promise<{ attemptId: string; executionId: string; binding: ExecutionRuntimeBinding }> {
  await controller.createMission(missionId, "finish an interrupted mission after runtime restart");
  const item = work(missionId);
  await controller.proposeWork(item);
  const attemptId = "attempt:recover-work:seed";
  const executionId = "execution:recover-work:seed";
  await controller.emit(missionId, "attempt.created", {
    id: attemptId,
    workItemId: item.id,
    executorId: "recovery-driver",
    contextPacketId: "context:seed",
    capabilityRefs: ["capability:seed"],
    executionIds: [executionId]
  });
  await controller.emit(missionId, "work.started", { id: item.id, attemptId });
  await controller.emit(missionId, "execution.created", {
    id: executionId,
    workItemId: item.id,
    attemptId,
    executorId: "recovery-driver",
    contextPacketId: "context:seed"
  });
  await controller.emit(missionId, "execution.started", { id: executionId, workItemId: item.id, attemptId });

  const binding: ExecutionRuntimeBinding = {
    executionId,
    attemptId,
    workItemId: item.id,
    driverId: "recovery-driver",
    hostHandleId: "host-handle-1",
    nativeRef: "native-session-1",
    workspaceRoot: "/tmp/mission-recovery-workspace",
    boundAt: new Date().toISOString()
  };
  if (includeBinding) {
    await controller.emit(missionId, "execution.bound", { id: executionId, binding });
  }
  return { attemptId, executionId, binding };
}

test("controller replacement recovers the bound execution and settles it through normal verification", async () => {
  const { db, store } = database();
  const missionId = "mission-recovery-restart";
  const firstController = new MissionController(store);
  const seeded = await seedBoundExecution(firstController, missionId, true);

  const before = activeExecutions(await store.list(missionId));
  assert.equal(before.length, 1);
  assert.equal(before[0]?.binding?.nativeRef, "native-session-1");
  assert.deepEqual(before[0]?.capabilityRefs, ["capability:seed"]);

  const driver = new RecoveryDriver();
  const replacement = new MissionController(store, undefined, driver, new RecoveryVerifier());

  try {
    const cycle = await replacement.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(driver.executeCalls, 0);
    assert.equal(driver.recoverCalls, 1);
    assert.equal(driver.lastRecovery?.executionId, seeded.executionId);
    assert.equal(driver.lastRecovery?.binding.nativeRef, "native-session-1");
    assert.deepEqual(driver.lastRecovery?.contextPacket.allowedCapabilityRefs, ["capability:seed"]);
    assert.equal(cycle.status, "completed");
    assert.deepEqual(cycle.executionsDispatched, [seeded.executionId]);
    assert.equal(cycle.verificationsScheduled.length, 1);

    const events = await store.list(missionId);
    const types = events.map(event => event.type);
    const recoveryIndex = types.indexOf("execution.recovery.started");
    const terminalIndex = types.indexOf("execution.completed");
    const verificationIndex = types.indexOf("verification.completed");
    const workCompletedIndex = types.indexOf("work.completed");
    assert.ok(recoveryIndex >= 0);
    assert.ok(terminalIndex > recoveryIndex);
    assert.ok(verificationIndex > terminalIndex);
    assert.ok(workCompletedIndex > verificationIndex);
    assert.equal(types.filter(type => type === "attempt.created").length, 1);
    assert.equal(activeExecutions(events).length, 0);
  } finally {
    db.close();
  }
});

test("active execution without a durable runtime binding becomes lost instead of staying stuck", async () => {
  const { db, store } = database();
  const missionId = "mission-recovery-unbound";
  const firstController = new MissionController(store);
  const seeded = await seedBoundExecution(firstController, missionId, false);
  const driver = new RecoveryDriver();
  const replacement = new MissionController(store, undefined, driver, new RecoveryVerifier());

  try {
    const cycle = await replacement.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(driver.recoverCalls, 0);
    assert.deepEqual(cycle.executionsDispatched, [seeded.executionId]);

    const events = await store.list(missionId);
    assert.equal(events.some(event => event.type === "execution.lost"), true);
    assert.equal(events.some(event => event.type === "work.failed"), true);
    assert.equal(events.some(event => event.type === "gap.opened" && (event.payload as { category?: string }).category === "runtime"), true);
    assert.equal(activeExecutions(events).length, 0);
  } finally {
    db.close();
  }
});
