import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { ExecutionResult } from "../../src/core/domain/execution.ts";
import type { MissionState, MissionSteeringMessage } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap, VerificationResult } from "../../src/core/domain/verification.ts";
import type { WorkExecutionDriver } from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider, StrategyProposal } from "../../src/core/planning/deliberation-provider.ts";
import type { Verifier, VerificationContext } from "../../src/core/verification/verifier.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function work(missionId: string, id: string, supersedesWorkItemRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: supersedesWorkItemRefs.length > 0 ? "repair" : "production",
    objective: supersedesWorkItemRefs.length > 0
      ? "produce the steered technical keynote with traceable sources"
      : "produce the original broad promotional keynote",
    status: "proposed",
    requirementRefs: ["req-keynote"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "file", required: true }],
    localAcceptanceCriteria: [{
      id: "keynote",
      description: "editable keynote follows the latest user steering",
      priority: "critical"
    }],
    capabilityNeedRefs: [],
    ...(supersedesWorkItemRefs.length > 0 ? { supersedesWorkItemRefs: [...supersedesWorkItemRefs] } : {}),
    priority: 100,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

class InitialPlanner implements DeliberationProvider {
  async composeStrategy() {
    return {
      framing: "broad technology keynote",
      approach: "original promotional direction",
      workstreams: [{ id: "keynote", objective: "produce keynote" }],
      revision: 1
    };
  }
  async planFrontier(input: { state: MissionState; openGaps: Gap[] }) {
    assert.deepEqual(input.openGaps, []);
    return { graphRevision: 1, capabilityNeeds: [], workItems: [work(input.state.missionId, "stale-ready-keynote")] };
  }
  async diagnoseGap(input: { gap: Gap }) {
    return { gapId: input.gap.id, rootCause: "not expected", intervention: "revise_work" as const, confidence: 1 };
  }
  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}

class SteeringAwarePlanner implements DeliberationProvider {
  readonly strategyInputs: Array<{
    state: MissionState;
    userGoal: string;
    steeringMessages?: MissionSteeringMessage[];
    currentStrategy?: StrategyProposal;
  }> = [];
  readonly frontierStates: MissionState[] = [];

  async composeStrategy(input: {
    state: MissionState;
    userGoal: string;
    steeringMessages?: MissionSteeringMessage[];
    currentStrategy?: StrategyProposal;
  }) {
    this.strategyInputs.push(structuredClone(input));
    assert.equal(input.currentStrategy?.framing, "broad technology keynote");
    assert.deepEqual(input.steeringMessages?.map(item => item.message), [
      "Make the keynote more technical, remove marketing language, and preserve source traceability."
    ]);
    return {
      framing: "technical evidence-first technology keynote",
      approach: "replace stale promotional Work with source-traceable technical production",
      workstreams: [{ id: "keynote", objective: "produce technical keynote" }],
      revision: 2
    };
  }

  async planFrontier(input: { state: MissionState; openGaps: Gap[] }) {
    this.frontierStates.push(structuredClone(input.state));
    assert.deepEqual(input.openGaps, []);
    assert.equal(input.state.strategyRevision, 2);
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(input.state.missionId, "steered-keynote", ["stale-ready-keynote"])]
    };
  }

  async diagnoseGap(input: { gap: Gap }) {
    return { gapId: input.gap.id, rootCause: "not expected", intervention: "revise_work" as const, confidence: 1 };
  }

  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}

class SteeringDriver implements WorkExecutionDriver {
  readonly id = "reference-steering-driver";
  readonly executedWorkIds: string[] = [];
  private readonly artifacts: FileArtifactStore;
  private readonly root: string;

  constructor(artifacts: FileArtifactStore, root: string) {
    this.artifacts = artifacts;
    this.root = root;
  }

  async execute(input: any) {
    this.executedWorkIds.push(input.workItem.id);
    const source = join(this.root, `${input.workItem.id}.txt`);
    await writeFile(source, "technical source-traceable editable keynote\n", "utf8");
    const artifact = this.artifacts.commit({
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

class SteeringVerifier implements Verifier {
  readonly id = "reference-steering-verifier";
  async verify(artifact: Artifact, _context?: VerificationContext): Promise<VerificationResult> {
    const evidenceRefs = [`evidence:steering:${artifact.id}:${artifact.version}`];
    return {
      id: `verification:steering:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "reference-steering-v1",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{
        id: "latest-steering",
        status: "pass",
        detail: "artifact follows the latest technical/source-traceable steering",
        evidenceRefs
      }],
      findingRefs: [],
      evidenceRefs,
      gapAssessments: [],
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

test("Reference Mission applies durable user steering after restart before stale ready Work can execute", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-steering-"));
  const dbPath = join(root, "mission.db");
  const missionId = "reference-mission-steering-restart";

  try {
    // Generation 1 deliberately has no execution driver. It creates a ready
    // WorkItem, then receives user steering and crashes before another cycle.
    const first = openRuntime(dbPath);
    try {
      const controller = new MissionController(
        first.events,
        new InitialPlanner(),
        undefined,
        undefined,
        undefined,
        first.reader
      );
      await controller.createMission(missionId, "Create an editable AI technology keynote.");
      const planned = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
      assert.deepEqual(planned.workItemsCreated, ["stale-ready-keynote"]);
      assert.deepEqual((await controller.state(missionId)).readyWorkItemIds, ["stale-ready-keynote"]);

      await controller.steer(
        missionId,
        "Make the keynote more technical, remove marketing language, and preserve source traceability."
      );
      const afterSteer = await controller.state(missionId);
      assert.equal(afterSteer.strategyRevision, 1);
      assert.deepEqual(afterSteer.readyWorkItemIds, ["stale-ready-keynote"]);
      const journal = await first.reader.journal(missionId);
      assert.equal(journal.steeringMessages.length, 1);
    } finally {
      first.database.close();
    }

    // Generation 2 uses a fresh controller and receives only durable state. A
    // manual wake must notice unapplied steering even without a special trigger.
    const second = openRuntime(dbPath);
    const planner = new SteeringAwarePlanner();
    const driver = new SteeringDriver(new FileArtifactStore(join(root, "artifacts")), root);
    try {
      const controller = new MissionController(
        second.events,
        planner,
        driver,
        new SteeringVerifier(),
        undefined,
        second.reader
      );
      const completed = await controller.runControllerCycle({ missionId, trigger: "manual" });
      assert.equal(completed.status, "completed");
      assert.deepEqual(driver.executedWorkIds, ["steered-keynote"]);
      assert.equal(planner.strategyInputs.length, 1);
      assert.equal(planner.frontierStates.length, 1);

      const journal = await second.reader.journal(missionId);
      assert.equal(journal.workItems.get("stale-ready-keynote")?.status, "superseded");
      assert.equal(journal.workItems.get("steered-keynote")?.status, "succeeded");
      const state = await controller.state(missionId);
      assert.equal(state.status, "completed");
      assert.equal(state.strategyRevision, 2);
      assert.equal(state.strategyAppliedSteeringSequence, journal.steeringMessages[0]!.sequence);
      assert.deepEqual(state.finalArtifactRefs, ["keynote@1"]);

      const events = await second.events.list(missionId);
      const steeringIndex = events.findIndex(event => event.type === "user.steering.received");
      const invalidatedIndex = events.findIndex((event, index) =>
        index > steeringIndex && event.type === "work.invalidated" && (event.payload as { id?: string }).id === "stale-ready-keynote"
      );
      const strategyIndex = events.findIndex((event, index) =>
        index > invalidatedIndex && event.type === "strategy.revised" &&
        (event.payload as { appliedSteeringSequence?: number }).appliedSteeringSequence === journal.steeringMessages[0]!.sequence
      );
      const replacementIndex = events.findIndex((event, index) =>
        index > strategyIndex && event.type === "work.created" && (event.payload as { id?: string }).id === "steered-keynote"
      );
      const supersededIndex = events.findIndex((event, index) =>
        index > replacementIndex && event.type === "work.updated" &&
        (event.payload as { id?: string; status?: string }).id === "stale-ready-keynote" &&
        (event.payload as { status?: string }).status === "superseded"
      );
      const startedIndex = events.findIndex((event, index) =>
        index > supersededIndex && event.type === "work.started" && (event.payload as { id?: string }).id === "steered-keynote"
      );
      assert.ok(steeringIndex >= 0);
      assert.ok(invalidatedIndex > steeringIndex);
      assert.ok(strategyIndex > invalidatedIndex);
      assert.ok(replacementIndex > strategyIndex);
      assert.ok(supersededIndex > replacementIndex);
      assert.ok(startedIndex > supersededIndex);
      assert.equal(events.some(event =>
        event.type === "work.started" && (event.payload as { id?: string }).id === "stale-ready-keynote"
      ), false);
    } finally {
      second.database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
