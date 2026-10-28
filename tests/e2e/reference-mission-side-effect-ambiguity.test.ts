import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type {
  ExecutionResult,
  ExecutionRuntimeBinding,
  SideEffectIntent,
  SideEffectPolicy
} from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap, VerificationResult } from "../../src/core/domain/verification.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome,
  WorkRecoveryInput
} from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { Verifier, VerificationContext } from "../../src/core/verification/verifier.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import type { ApprovalRequest, ApprovalResult } from "../../src/hosts/deepseek/host-adapter.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import {
  RuntimeSideEffectManager,
  type SideEffectApprovalBroker,
  type SideEffectApprovalRequest
} from "../../src/runtime/side-effect-manager.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

const sideEffectPolicy: SideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "approval",
  idempotencyRequired: true
};

function work(missionId: string, id: string, gapRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: gapRefs.length > 0 ? "repair" : "production",
    objective: gapRefs.length > 0
      ? "finish the keynote without replaying the ambiguous external publish"
      : "produce the keynote and publish one external release notification",
    status: "proposed",
    requirementRefs: ["req-keynote-deliverable"],
    gapRefs: [...gapRefs],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "file", required: true }],
    localAcceptanceCriteria: [{
      id: "keynote-safe-completion",
      description: "deliver the editable keynote while never replaying an already-admitted ambiguous publish",
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

class SideEffectRecoveryPlanner implements DeliberationProvider {
  frontierCalls = 0;
  diagnosisCalls: string[] = [];
  completionChallenges = 0;

  async composeStrategy() {
    return {
      framing: "preserve exactly-once external effects while repairing the final keynote locally",
      approach: "recover first, fail closed on ambiguous external state, then replan without replay",
      workstreams: [{ id: "keynote", objective: "deliver a verified keynote safely" }],
      revision: 1
    };
  }

  async planFrontier(input: { state: any; openGaps: Gap[] }) {
    this.frontierCalls += 1;
    if (input.openGaps.length === 0) {
      return {
        graphRevision: 1,
        capabilityNeeds: [],
        workItems: [work(input.state.missionId, "reference-publish-production")]
      };
    }
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(
        input.state.missionId,
        `reference-publish-repair-${this.frontierCalls - 1}`,
        input.openGaps.map(gap => gap.id).sort()
      )]
    };
  }

  async diagnoseGap(input: { gap: Gap }) {
    this.diagnosisCalls.push(input.gap.id);
    return {
      gapId: input.gap.id,
      rootCause: "the provider-native execution died after an irreversible effect was admitted and externally observed but before terminal receipt persistence",
      intervention: "revise_work" as const,
      confidence: 0.99
    };
  }

  async challengeCompletion() {
    this.completionChallenges += 1;
    return { blockingObjection: false, objections: [], confidence: 0.99 };
  }
}

class AlwaysApproveBroker implements SideEffectApprovalBroker {
  sideEffectApprovals = 0;

  async requestHostApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: true, scope: "once" };
  }

  async requestSideEffectApproval(_request: SideEffectApprovalRequest) {
    this.sideEffectApprovals += 1;
    return { approved: true, actor: "reference-operator" };
  }
}

function intent(
  missionId: string,
  workItemId: string,
  attemptId: string,
  executionId: string,
  target: string
): SideEffectIntent {
  return {
    id: `intent:${executionId}:publish`,
    missionId,
    workItemId,
    attemptId,
    executionId,
    source: "runtime-action",
    operationKey: `reference:${missionId}:${executionId}:publish-keynote`,
    fingerprint: "reference-keynote-publish-v1",
    effectClass: "irreversible-action",
    type: "message",
    target,
    reversible: false,
    description: "publish the final keynote release notification exactly once",
    createdAt: new Date().toISOString(),
    metadata: { scenario: "reference-side-effect-ambiguity" }
  };
}

class AmbiguousRecoveryDriver implements WorkExecutionDriver {
  readonly id = "reference-side-effect-driver";
  readonly recoveries: string[] = [];
  readonly executedWorkIds: string[] = [];
  readonly replayStatuses: string[] = [];

  constructor(
    private readonly sideEffects: RuntimeSideEffectManager,
    private readonly artifactStore: FileArtifactStore,
    private readonly root: string,
    private readonly externalTarget: string
  ) {}

  async recover(input: WorkRecoveryInput): Promise<WorkExecutionOutcome> {
    this.recoveries.push(input.executionId);
    const authorization = await this.sideEffects.authorize(
      intent(input.state.missionId, input.workItem.id, input.attemptId, input.executionId, this.externalTarget),
      sideEffectPolicy
    );
    this.replayStatuses.push(authorization.admission.status);

    if (authorization.admission.status === "admitted") {
      await appendFile(this.externalTarget, "duplicate publish\n", "utf8");
    }

    const now = new Date().toISOString();
    return {
      result: {
        executionId: input.executionId,
        state: "lost",
        producedFiles: [],
        committedArtifactRefs: [],
        sideEffects: [{
          type: "message",
          target: this.externalTarget,
          reversible: false,
          result: authorization.admission.reason,
          intentId: authorization.intent.id,
          operationKey: authorization.intent.operationKey,
          effectClass: authorization.intent.effectClass,
          status: authorization.admission.status
        }],
        startedAt: now,
        endedAt: now
      },
      artifacts: []
    };
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    this.executedWorkIds.push(input.workItem.id);
    assert.ok(input.workItem.gapRefs.length > 0, "only the repair Work should execute after recovery");

    const source = join(this.root, `${input.workItem.id}.txt`);
    await writeFile(source, "editable keynote repaired locally without replaying external publish\n", "utf8");
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

class SideEffectRecoveryVerifier implements Verifier {
  readonly id = "reference-side-effect-verifier";
  calls = 0;

  async verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult> {
    this.calls += 1;
    const evidenceRefs = [`evidence:side-effect-repair:${artifact.id}:${artifact.version}`];
    return {
      id: `verification:side-effect-repair:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "reference-keynote-side-effect-recovery-v1",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{
        id: "safe-repair-deliverable",
        status: "pass",
        detail: "the repaired artifact is complete and required no replay of the ambiguous irreversible side effect",
        evidenceRefs
      }],
      findingRefs: [],
      evidenceRefs,
      gapAssessments: (context?.gaps ?? []).map(gap => ({
        gapId: gap.id,
        status: "resolved" as const,
        evidenceRefs,
        confidence: 0.99,
        detail: "repair work completed locally while the ambiguous external publish remained replay-blocked"
      })),
      createdAt: new Date().toISOString()
    };
  }
}

function openRuntime(dbPath: string) {
  const database = new MissionDatabase(dbPath);
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  return { database, events, reader };
}

async function seedActiveExecution(
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
    driverId: "reference-side-effect-driver",
    hostHandleId: "host-handle-before-ambiguous-crash",
    nativeRef: "provider-session-before-ambiguous-crash",
    workspaceRoot,
    boundAt: new Date().toISOString()
  };

  await controller.emit(missionId, "attempt.created", {
    id: attemptId,
    workItemId: workItem.id,
    executorId: binding.driverId,
    contextPacketId: "context-before-ambiguous-crash",
    capabilityRefs: [],
    executionIds: [executionId]
  }, { type: "controller" }, `attempt-created:${attemptId}`);
  await controller.emit(missionId, "work.started", { id: workItem.id, attemptId }, { type: "controller" }, `work-started:${attemptId}`);
  await controller.emit(missionId, "execution.created", {
    id: executionId,
    workItemId: workItem.id,
    attemptId,
    executorId: binding.driverId,
    contextPacketId: "context-before-ambiguous-crash"
  }, { type: "controller" }, `execution-created:${executionId}`);
  await controller.emit(missionId, "execution.started", {
    id: executionId,
    workItemId: workItem.id,
    attemptId
  }, { type: "host" }, `execution-started:${executionId}`);
  await controller.emit(missionId, "execution.bound", { id: executionId, binding }, { type: "host", id: binding.driverId }, `execution-bound:${executionId}`);
  return { attemptId, executionId };
}

test("Reference Mission blocks replay after ambiguous irreversible side effect and replans to safe completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-side-effect-"));
  const dbPath = join(root, "mission.db");
  const externalTarget = join(root, "external-publish-log.txt");
  const missionId = "reference-mission-side-effect-ambiguity";
  const planner = new SideEffectRecoveryPlanner();

  try {
    const firstRuntime = openRuntime(dbPath);
    const firstBroker = new AlwaysApproveBroker();
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
        "Produce and safely deliver the AI keynote; never duplicate irreversible external publication."
      );
      const planned = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
      assert.deepEqual(planned.workItemsCreated, ["reference-publish-production"]);

      const journal = await firstRuntime.reader.journal(missionId);
      const initialWork = journal.workItems.get("reference-publish-production");
      assert.ok(initialWork);
      const seeded = await seedActiveExecution(controller, missionId, initialWork!, join(root, "workspace-before-crash"));

      const sideEffects = new RuntimeSideEffectManager(firstRuntime.events, firstBroker);
      const authorization = await sideEffects.authorize(
        intent(missionId, initialWork!.id, seeded.attemptId, seeded.executionId, externalTarget),
        sideEffectPolicy
      );
      assert.equal(authorization.admission.status, "admitted");
      assert.equal(firstBroker.sideEffectApprovals, 1);

      // External system accepted the irreversible effect. The process dies before
      // Runtime can persist side_effect.completed/failed, leaving durable admission
      // but intentionally ambiguous external completion state.
      await appendFile(externalTarget, "publish accepted\n", "utf8");
      const beforeCrash = await controller.state(missionId);
      assert.equal(beforeCrash.activeExecutionIds.length, 1);
      assert.equal((await readFile(externalTarget, "utf8")).trim(), "publish accepted");
    } finally {
      firstRuntime.database.close();
    }

    const secondRuntime = openRuntime(dbPath);
    const secondBroker = new AlwaysApproveBroker();
    const sideEffectsAfterRestart = new RuntimeSideEffectManager(secondRuntime.events, secondBroker);
    const driver = new AmbiguousRecoveryDriver(
      sideEffectsAfterRestart,
      new FileArtifactStore(join(root, "artifacts")),
      root,
      externalTarget
    );
    const verifier = new SideEffectRecoveryVerifier();

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
      assert.equal(recovered.status, "completed");
      assert.equal(secondBroker.sideEffectApprovals, 0, "recovery must not ask to re-approve an already-admitted ambiguous effect");
      assert.deepEqual(driver.replayStatuses, ["replay_blocked"]);
      assert.equal(driver.recoveries.length, 1);
      assert.deepEqual(driver.executedWorkIds, ["reference-publish-repair-1"]);
      assert.equal(verifier.calls, 1);
      assert.equal(planner.completionChallenges, 1);

      const externalLog = (await readFile(externalTarget, "utf8")).trim().split("\n");
      assert.deepEqual(externalLog, ["publish accepted"], "ambiguous irreversible effect must never execute twice");

      const state = await controller.state(missionId);
      assert.equal(state.status, "completed");
      assert.deepEqual(state.blockingGapIds, []);
      assert.deepEqual(state.openGapIds, []);
      assert.deepEqual(state.finalArtifactRefs, ["keynote@1"]);

      const events = await secondRuntime.events.list(missionId);
      const sideEffectEvents = events.filter(event => event.type.startsWith("side_effect."));
      assert.equal(sideEffectEvents.filter(event => event.type === "side_effect.intent.recorded").length, 1);
      assert.equal(sideEffectEvents.filter(event => event.type === "side_effect.admitted").length, 1);
      assert.equal(sideEffectEvents.filter(event => event.type === "side_effect.replay_blocked").length, 1);
      assert.equal(sideEffectEvents.filter(event => event.type === "side_effect.completed").length, 0);
      assert.equal(sideEffectEvents.filter(event => event.type === "side_effect.failed").length, 0);

      const recoveryStarted = events.findIndex(event => event.type === "execution.recovery.started");
      const replayBlocked = events.findIndex((event, index) => index > recoveryStarted && event.type === "side_effect.replay_blocked");
      const executionLost = events.findIndex((event, index) => index > replayBlocked && event.type === "execution.lost");
      const gapOpened = events.findIndex((event, index) => index > executionLost && event.type === "gap.opened");
      const repairCreated = events.findIndex((event, index) =>
        index > gapOpened && event.type === "work.created" && (event.payload as { id?: string }).id === "reference-publish-repair-1"
      );
      const gapResolved = events.findIndex((event, index) => index > repairCreated && event.type === "gap.resolved");
      const missionCompleted = events.findIndex((event, index) => index > gapResolved && event.type === "mission.completed");

      assert.ok(recoveryStarted >= 0);
      assert.ok(replayBlocked > recoveryStarted);
      assert.ok(executionLost > replayBlocked);
      assert.ok(gapOpened > executionLost);
      assert.ok(repairCreated > gapOpened);
      assert.ok(gapResolved > repairCreated);
      assert.ok(missionCompleted > gapResolved);
      assert.ok(planner.diagnosisCalls.length >= 1);
    } finally {
      secondRuntime.database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
