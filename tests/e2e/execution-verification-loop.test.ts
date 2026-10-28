import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { BasicFileVerifier } from "../../src/core/verification/basic-file-verifier.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { ExecutionResult } from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { VerificationResult } from "../../src/core/domain/verification.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkExecutionDriver } from "../../src/core/execution/work-execution-driver.ts";
import type { Verifier } from "../../src/core/verification/verifier.ts";

function setup(root: string, provider: DeliberationProvider, driver: WorkExecutionDriver, verifier: Verifier) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const store = new SqliteEventStore(db);
  const controller = new MissionController(store, provider, driver, verifier);
  return { db, store, controller };
}

function productionWork(missionId: string, id: string, gapRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: gapRefs.length > 0 ? "repair" : "production",
    objective: gapRefs.length > 0 ? "repair the failed deliverable" : "produce the deliverable",
    status: "proposed",
    requirementRefs: ["req-deliverable"],
    gapRefs,
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "local-file", description: "deliverable exists and is non-empty", priority: "critical" }],
    capabilityNeedRefs: [],
    priority: 100,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function fileDriver(root: string, artifacts: FileArtifactStore): WorkExecutionDriver {
  return {
    id: "file-driver",
    async execute(input) {
      const source = join(root, `${input.executionId.replaceAll(":", "-")}.txt`);
      await writeFile(source, `artifact for ${input.workItem.id}\n`, "utf8");
      const artifact = artifacts.commit({
        missionId: input.workItem.missionId,
        logicalName: "deliverable",
        type: "file",
        sourcePath: source,
        producedByAttemptId: input.attemptId
      });
      const ref = `${artifact.id}@${artifact.version}`;
      const now = new Date().toISOString();
      const result: ExecutionResult = {
        executionId: input.executionId,
        state: "succeeded",
        exitCode: 0,
        producedFiles: [{ path: artifact.uri, logicalName: artifact.logicalName, type: artifact.type }],
        committedArtifactRefs: [ref],
        sideEffects: [],
        startedAt: now,
        endedAt: now
      };
      return { result, artifacts: [artifact] };
    }
  };
}

class MissionFileVerifier implements Verifier {
  readonly id = "mission-file-verifier";
  private readonly base = new BasicFileVerifier();

  async verify(artifact: Artifact): Promise<VerificationResult> {
    const result = await this.base.verify(artifact);
    return { ...result, id: `mission-check:${artifact.id}:${artifact.version}`, verifierId: this.id, verificationProfileId: "mission-file", level: "mission" };
  }
}

class FailingVerifier implements Verifier {
  readonly id = "failing-verifier";
  async verify(artifact: Artifact): Promise<VerificationResult> {
    return {
      id: `failed-check:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "forced-failure",
      verifierId: this.id,
      level: "quality",
      overall: "fail",
      checkResults: [{ id: "quality-gate", status: "fail", detail: "forced quality failure", evidenceRefs: [] }],
      findingRefs: [],
      evidenceRefs: [],
      createdAt: new Date().toISOString()
    };
  }
}

test("controller executes ready work, commits artifact, verifies independently, challenges and completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-execution-e2e-"));
  const artifactStore = new FileArtifactStore(join(root, "artifact-store"));
  let frontierCalls = 0;
  let completionChallenges = 0;
  const provider: DeliberationProvider = {
    async composeStrategy() {
      return { framing: "produce then verify", approach: "single verified frontier", workstreams: [], revision: 1 };
    },
    async planFrontier({ state }) {
      frontierCalls += 1;
      return { workItems: [productionWork(state.missionId, "produce-1")], graphRevision: 1 };
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "verification", intervention: "revise_work", confidence: 0.9 };
    },
    async challengeCompletion() {
      completionChallenges += 1;
      return { blockingObjection: false, objections: [], confidence: 0.99 };
    }
  };
  const { db, store, controller } = setup(root, provider, fileDriver(root, artifactStore), new MissionFileVerifier());

  try {
    await controller.createMission("mission-execution-pass", "produce a verified deliverable");
    const cycle = await controller.runControllerCycle({ missionId: "mission-execution-pass", trigger: "mission_created" });

    assert.equal(cycle.status, "completed");
    assert.equal(frontierCalls, 1);
    assert.equal(completionChallenges, 1);
    assert.equal(cycle.executionsDispatched.length, 1);
    assert.equal(cycle.verificationsScheduled.length, 1);

    const events = await store.list("mission-execution-pass");
    const index = (type: string) => events.findIndex(event => event.type === type);
    assert.ok(index("work.created") >= 0);
    assert.ok(index("execution.started") > index("work.created"));
    assert.ok(index("artifact.created") > index("execution.started"));
    assert.ok(index("verification.started") > index("artifact.created"));
    assert.ok(index("artifact.validated") > index("verification.started"));
    assert.ok(index("work.completed") > index("artifact.validated"));
    assert.ok(index("mission.completed") > index("work.completed"));

    const created = events.find(event => event.type === "artifact.created");
    const artifact = (created?.payload as { artifact?: Artifact })?.artifact;
    assert.ok(artifact);
    assert.equal(existsSync(artifact!.uri), true);
    assert.equal(artifact!.status, "candidate");

    const state = await controller.state("mission-execution-pass");
    assert.deepEqual(state.finalArtifactRefs, ["deliverable@1"]);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed independent verification opens a gap that is diagnosed before repair frontier on the next cycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-verification-fail-"));
  const artifactStore = new FileArtifactStore(join(root, "artifact-store"));
  let frontierCalls = 0;
  let diagnosisCalls = 0;
  const provider: DeliberationProvider = {
    async composeStrategy() {
      return { framing: "produce and repair", approach: "respond to verified gaps", workstreams: [], revision: 1 };
    },
    async planFrontier({ state, openGaps }) {
      frontierCalls += 1;
      if (frontierCalls === 1) return { workItems: [productionWork(state.missionId, "produce-failing")], graphRevision: 1 };
      assert.equal(openGaps.length, 1);
      return { workItems: [productionWork(state.missionId, "repair-verified-gap", [openGaps[0]!.id])], graphRevision: 2 };
    },
    async diagnoseGap({ gap }) {
      diagnosisCalls += 1;
      return { gapId: gap.id, rootCause: "independent quality failure", intervention: "revise_work", confidence: 0.97 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    }
  };
  const { db, store, controller } = setup(root, provider, fileDriver(root, artifactStore), new FailingVerifier());

  try {
    await controller.createMission("mission-execution-fail", "repair any independently verified failure");
    const first = await controller.runControllerCycle({ missionId: "mission-execution-fail", trigger: "mission_created" });
    assert.equal(first.status, "active");
    assert.equal(first.executionsDispatched.length, 1);
    assert.equal(first.verificationsScheduled.length, 1);

    let state = await controller.state("mission-execution-fail");
    assert.equal(state.blockingGapIds.length, 1);
    assert.deepEqual(state.readyWorkItemIds, []);
    assert.deepEqual(state.activeWorkItemIds, []);

    const second = await controller.runControllerCycle({ missionId: "mission-execution-fail", trigger: "verification_event" });
    assert.equal(diagnosisCalls, 1);
    assert.ok(second.decisionsCreated.some(id => id.startsWith("gap-diagnosis:verification-gap:")));
    assert.ok(second.workItemsCreated.includes("repair-verified-gap"));

    const events = await store.list("mission-execution-fail");
    const gapIndex = events.findIndex(event => event.type === "gap.opened");
    const diagnosisIndex = events.findIndex((event, index) => index > gapIndex && event.type === "decision.created");
    const repairIndex = events.findIndex((event, index) => index > diagnosisIndex && event.type === "work.created" && (event.payload as { id?: string }).id === "repair-verified-gap");
    assert.ok(gapIndex >= 0 && diagnosisIndex > gapIndex && repairIndex > diagnosisIndex);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
