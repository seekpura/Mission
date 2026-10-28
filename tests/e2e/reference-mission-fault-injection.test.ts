import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { ExecutionResult, ExecutionRuntimeBinding } from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap, VerificationResult } from "../../src/core/domain/verification.ts";
import type { WorkExecutionDriver, WorkExecutionOutcome } from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { Verifier, VerificationContext } from "../../src/core/verification/verifier.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function work(missionId: string, id: string, gapRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: gapRefs.length > 0 ? "repair" : "production",
    objective: gapRefs.length > 0
      ? "repair the keynote deliverable using the currently open verified/runtime gaps"
      : "produce the editable keynote deliverable",
    status: "proposed",
    requirementRefs: ["req-keynote-deliverable"],
    gapRefs: [...gapRefs],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "file", required: true }],
    localAcceptanceCriteria: [{
      id: "keynote-artifact",
      description: "an editable non-empty keynote artifact exists",
      priority: "critical"
    }],
    capabilityNeedRefs: [],
    priority: 100,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

class ReferencePlanner implements DeliberationProvider {
  frontierCalls = 0;
  diagnosisCalls: string[] = [];
  completionChallenges = 0;

  async composeStrategy() {
    return {
      framing: "recover, diagnose, repair and independently verify the keynote",
      approach: "progressive evidence-backed frontiers",
      workstreams: [{ id: "keynote", objective: "produce the verified keynote deliverable" }],
      revision: 1
    };
  }

  async planFrontier(input: { state: any; openGaps: Gap[] }) {
    this.frontierCalls += 1;
    const gapRefs = input.openGaps.map(gap => gap.id).sort();
    if (gapRefs.length === 0) {
      return {
        graphRevision: 1,
        capabilityNeeds: [],
        workItems: [work(input.state.missionId, "reference-keynote-production")]
      };
    }
    const repairOrdinal = this.frontierCalls - 1;
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(input.state.missionId, `reference-keynote-repair-${repairOrdinal}`, gapRefs)]
    };
  }

  async diagnoseGap(input: { gap: Gap }) {
    this.diagnosisCalls.push(input.gap.id);
    return {
      gapId: input.gap.id,
      rootCause: `fault-injection root cause for ${input.gap.category}`,
      intervention: "revise_work" as const,
      confidence: 0.99
    };
  }

  async challengeCompletion() {
    this.completionChallenges += 1;
    return { blockingObjection: false, objections: [], confidence: 0.99 };
  }
}

class ReferenceFaultDriver implements WorkExecutionDriver {
  readonly id = "reference-fault-driver";
  readonly recoveredExecutionIds: string[] = [];
  readonly executedWorkIds: string[] = [];
  private readonly artifactStore: FileArtifactStore;
  private readonly sourceRoot: string;

  constructor(artifactStore: FileArtifactStore, sourceRoot: string) {
    this.artifactStore = artifactStore;
    this.sourceRoot = sourceRoot;
  }

  async recover(input: any): Promise<WorkExecutionOutcome> {
    this.recoveredExecutionIds.push(input.executionId);
    const now = new Date().toISOString();
    return {
      result: {
        executionId: input.executionId,
        state: "lost",
        producedFiles: [],
        committedArtifactRefs: [],
        sideEffects: [],
        startedAt: now,
        endedAt: now
      },
      artifacts: []
    };
  }

  async execute(input: any): Promise<WorkExecutionOutcome> {
    this.executedWorkIds.push(input.workItem.id);
    const source = join(this.sourceRoot, `${input.workItem.id}.txt`);
    await writeFile(source, `reference keynote artifact from ${input.workItem.id}\n`, "utf8");
    const artifact = this.artifactStore.commit({
      missionId: input.workItem.missionId,
      logicalName: "keynote",
      type: "file",
      sourcePath: source,
      producedByAttemptId: input.attemptId
    });
    const now = new Date().toISOString();
    const result: ExecutionResult = {
      executionId: input.executionId,
      state: "succeeded",
      exitCode: 0,
      producedFiles: [{ path: artifact.uri, logicalName: artifact.logicalName, type: artifact.type }],
      committedArtifactRefs: [`${artifact.id}@${artifact.version}`],
      sideEffects: [],
      startedAt: now,
      endedAt: now
    };
    return { result, artifacts: [artifact] };
  }
}

class FailOnceReferenceVerifier implements Verifier {
  readonly id = "reference-independent-verifier";
  calls = 0;

  async verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult> {
    this.calls += 1;
    if (this.calls === 1) throw new Error("injected verifier process fault");
    const gaps = context?.gaps ?? [];
    const evidenceRefs = [`evidence:reference:${artifact.id}:${artifact.version}`];
    return {
      id: `reference-verification:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "reference-keynote-mission-v1",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{
        id: "reference-keynote-acceptance",
        status: "pass",
        detail: "replacement artifact passed the independent Reference Mission acceptance check",
        evidenceRefs
      }],
      findingRefs: [],
      evidenceRefs,
      gapAssessments: gaps.map(gap => ({
        gapId: gap.id,
        status: "resolved" as const,
        evidenceRefs,
        confidence: 0.99,
        detail: "replacement artifact addresses the injected runtime/verifier fault"
      })),
      createdAt: new Date().toISOString()
    };
  }
}

function openRuntime(root: string, dbPath: string) {
  const database = new MissionDatabase(dbPath);
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  return { database, events, reader };
}

async function seedCrashCheckpoint(
  controller: MissionController,
  missionId: string,
  workItem: WorkItem,
  workspaceRoot: string
) {
  const attemptId = `attempt:${workItem.id}:pre-crash`;
  const executionId = `execution:${workItem.id}:pre-crash`;
  const binding: ExecutionRuntimeBinding = {
    executionId,
    attemptId,
    workItemId: workItem.id,
    driverId: "reference-fault-driver",
    hostHandleId: "host-handle-before-process-death",
    nativeRef: "native-session-that-will-be-lost",
    workspaceRoot,
    boundAt: new Date().toISOString()
  };

  await controller.emit(missionId, "attempt.created", {
    id: attemptId,
    workItemId: workItem.id,
    executorId: binding.driverId,
    contextPacketId: "context-before-process-death",
    capabilityRefs: [],
    executionIds: [executionId]
  }, { type: "controller" }, `attempt-created:${attemptId}`);
  await controller.emit(missionId, "work.started", { id: workItem.id, attemptId }, { type: "controller" }, `work-started:${attemptId}`);
  await controller.emit(missionId, "execution.created", {
    id: executionId,
    workItemId: workItem.id,
    attemptId,
    executorId: binding.driverId,
    contextPacketId: "context-before-process-death"
  }, { type: "controller" }, `execution-created:${executionId}`);
  await controller.emit(missionId, "execution.started", {
    id: executionId,
    workItemId: workItem.id,
    attemptId
  }, { type: "host" }, `execution-started:${executionId}`);
  await controller.emit(missionId, "execution.bound", { id: executionId, binding }, { type: "host", id: binding.driverId }, `execution-bound:${executionId}`);
  return { attemptId, executionId };
}

test("Reference Mission survives process death, lost native session, verifier fault and repeated repair before completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-faults-"));
  const dbPath = join(root, "mission.db");
  const missionId = "reference-mission-combined-faults";
  const planner = new ReferencePlanner();

  try {
    // Process generation 1: create the Mission/frontier, then persist the exact
    // active execution binding a real process would leave behind at crash time.
    const firstRuntime = openRuntime(root, dbPath);
    try {
      const controller = new MissionController(
        firstRuntime.events,
        planner,
        undefined,
        undefined,
        undefined,
        firstRuntime.reader
      );
      await controller.createMission(
        missionId,
        "Produce a high-production AI technology keynote with editable slides, notes, supporting media and source record."
      );
      const planned = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
      assert.deepEqual(planned.workItemsCreated, ["reference-keynote-production"]);
      const journal = await firstRuntime.reader.journal(missionId);
      const initialWork = journal.workItems.get("reference-keynote-production");
      assert.ok(initialWork);
      await seedCrashCheckpoint(controller, missionId, initialWork!, join(root, "workspace-before-crash"));
      const beforeCrash = await controller.state(missionId);
      assert.equal(beforeCrash.activeExecutionIds.length, 1);
    } finally {
      firstRuntime.database.close();
    }

    // Process generation 2: the old provider-native session is gone. Recovery
    // reports `lost`; Runtime must convert that into a durable gap, diagnose it,
    // plan replacement Work and continue. The first replacement verifier itself
    // then crashes, creating a second independent runtime gap.
    const secondRuntime = openRuntime(root, dbPath);
    const artifactStore = new FileArtifactStore(join(root, "artifact-store"));
    const driver = new ReferenceFaultDriver(artifactStore, root);
    const verifier = new FailOnceReferenceVerifier();
    try {
      const controller = new MissionController(
        secondRuntime.events,
        planner,
        driver,
        verifier,
        undefined,
        secondRuntime.reader
      );

      const recovered = await controller.runControllerCycle({ missionId, trigger: "manual" });
      assert.equal(recovered.status, "active");
      assert.equal(driver.recoveredExecutionIds.length, 1);
      assert.deepEqual(driver.executedWorkIds, ["reference-keynote-repair-1"]);
      assert.equal(verifier.calls, 1);

      let state = await controller.state(missionId);
      assert.equal(state.activeExecutionIds.length, 0);
      assert.ok(state.blockingGapIds.length >= 2);
      assert.equal(state.finalArtifactRefs.length, 0);

      const afterFirstRepair = await secondRuntime.reader.journal(missionId);
      const openAfterFirstRepair = [...afterFirstRepair.gaps.values()].filter(gap => gap.status !== "resolved");
      assert.ok(openAfterFirstRepair.some(gap => gap.category === "runtime" && gap.description.includes("state lost")));
      assert.ok(openAfterFirstRepair.some(gap => gap.category === "runtime" && gap.description.includes("injected verifier process fault")));

      // A later controller wake must diagnose the still-open gaps, create a new
      // repair frontier instead of replaying the lost execution, independently
      // verify the replacement artifact and close only the gaps explicitly
      // assessed as resolved.
      const repaired = await controller.runControllerCycle({ missionId, trigger: "verification_event" });
      assert.equal(repaired.status, "completed");
      assert.deepEqual(driver.executedWorkIds, ["reference-keynote-repair-1", "reference-keynote-repair-2"]);
      assert.equal(driver.recoveredExecutionIds.length, 1);
      assert.equal(verifier.calls, 2);
      assert.equal(planner.completionChallenges, 1);

      state = await controller.state(missionId);
      assert.equal(state.status, "completed");
      assert.deepEqual(state.blockingGapIds, []);
      assert.deepEqual(state.openGapIds, []);
      assert.deepEqual(state.finalArtifactRefs, ["keynote@2"]);

      const events = await secondRuntime.events.list(missionId);
      const types = events.map(event => event.type);
      const recoveryStart = types.indexOf("execution.recovery.started");
      const lost = types.indexOf("execution.lost", recoveryStart + 1);
      const firstRuntimeGap = types.indexOf("gap.opened", lost + 1);
      const firstRepairWork = events.findIndex((event, index) =>
        index > firstRuntimeGap && event.type === "work.created" && (event.payload as { id?: string }).id === "reference-keynote-repair-1"
      );
      const verifierFault = events.findIndex((event, index) =>
        index > firstRepairWork && event.type === "verification.completed" && JSON.stringify(event.payload).includes("injected verifier process fault")
      );
      const secondRepairWork = events.findIndex((event, index) =>
        index > verifierFault && event.type === "work.created" && (event.payload as { id?: string }).id === "reference-keynote-repair-2"
      );
      const missionCompleted = types.lastIndexOf("mission.completed");

      assert.ok(recoveryStart >= 0);
      assert.ok(lost > recoveryStart);
      assert.ok(firstRuntimeGap > lost);
      assert.ok(firstRepairWork > firstRuntimeGap);
      assert.ok(verifierFault > firstRepairWork);
      assert.ok(secondRepairWork > verifierFault);
      assert.ok(missionCompleted > secondRepairWork);
      assert.ok(planner.diagnosisCalls.length >= 3);
    } finally {
      secondRuntime.database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
