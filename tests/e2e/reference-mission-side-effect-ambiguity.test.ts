import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionResult, SideEffectRecord } from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap, VerificationResult } from "../../src/core/domain/verification.ts";
import type { WorkExecutionDriver } from "../../src/core/execution/work-execution-driver.ts";
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

function work(
  missionId: string,
  id: string,
  gapRefs: string[] = [],
  supersedesWorkItemRefs: string[] = []
): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: gapRefs.length > 0 ? "repair" : "production",
    objective: gapRefs.length > 0
      ? "reconcile ambiguous publication state without replaying the external write, then produce the safe final keynote"
      : "produce the keynote and publish its external launch record once",
    status: "proposed",
    requirementRefs: ["req-keynote"],
    gapRefs: [...gapRefs],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "keynote", description: "verified keynote artifact", priority: "critical" }],
    capabilityNeedRefs: [],
    ...(supersedesWorkItemRefs.length > 0 ? { supersedesWorkItemRefs: [...supersedesWorkItemRefs] } : {}),
    priority: 100,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

class AmbiguityPlanner implements DeliberationProvider {
  frontierCalls = 0;
  diagnosisCalls: string[] = [];

  async composeStrategy() {
    return {
      framing: "perform the external launch action at most once and fail closed if completion is ambiguous",
      approach: "publish once, reconcile ambiguity, repair without replay",
      workstreams: [{ id: "launch", objective: "deliver verified keynote safely" }],
      revision: 1
    };
  }

  async planFrontier(input: { state: any; openGaps: Gap[] }) {
    this.frontierCalls += 1;
    if (input.openGaps.length === 0) {
      return { graphRevision: 1, capabilityNeeds: [], workItems: [work(input.state.missionId, "keynote-publish-once")] };
    }
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(
        input.state.missionId,
        "keynote-reconcile-without-replay",
        input.openGaps.map(gap => gap.id).sort(),
        ["keynote-publish-once"]
      )]
    };
  }

  async diagnoseGap(input: { gap: Gap }) {
    this.diagnosisCalls.push(input.gap.id);
    assert.equal(input.gap.category, "runtime");
    return {
      gapId: input.gap.id,
      rootCause: "external side-effect completion is ambiguous after provider completion",
      intervention: "revise_work" as const,
      confidence: 0.99
    };
  }

  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 0.99 };
  }
}

class AmbiguousThenSafeDriver implements WorkExecutionDriver {
  readonly id = "reference-side-effect-driver";
  readonly executedWorkIds: string[] = [];
  irreversibleInvocations = 0;
  private readonly artifacts: FileArtifactStore;
  private readonly root: string;

  constructor(artifacts: FileArtifactStore, root: string) {
    this.artifacts = artifacts;
    this.root = root;
  }

  async execute(input: any) {
    this.executedWorkIds.push(input.workItem.id);
    const source = join(this.root, `${input.workItem.id}.txt`);
    await writeFile(source, `keynote from ${input.workItem.id}\n`, "utf8");
    const artifact = this.artifacts.commit({
      missionId: input.workItem.missionId,
      logicalName: "keynote",
      type: "file",
      sourcePath: source,
      producedByAttemptId: input.attemptId
    });
    const now = new Date().toISOString();
    let sideEffects: SideEffectRecord[] = [];
    if (input.workItem.id === "keynote-publish-once") {
      this.irreversibleInvocations += 1;
      sideEffects = [{
        type: "external-write",
        target: "https://publisher.example/launch-record",
        reversible: false,
        result: "provider returned terminal completion before tool completion could be observed",
        intentId: "intent-publish-once",
        operationKey: "publish-once",
        effectClass: "irreversible-action",
        status: "unknown"
      }];
    }
    const result: ExecutionResult = {
      executionId: input.executionId,
      // Fault injection: buggy/provider-specific driver claims success even though
      // its admitted irreversible side effect has no known completion outcome.
      state: "succeeded",
      exitCode: 0,
      producedFiles: [{ path: artifact.uri, logicalName: artifact.logicalName, type: artifact.type }],
      committedArtifactRefs: [`${artifact.id}@${artifact.version}`],
      sideEffects,
      startedAt: now,
      endedAt: now
    };
    return { result, artifacts: [artifact] };
  }
}

class SafeRepairVerifier implements Verifier {
  readonly id = "reference-side-effect-verifier";
  calls = 0;

  async verify(artifact: any, context?: VerificationContext): Promise<VerificationResult> {
    this.calls += 1;
    const evidenceRefs = [`evidence:safe-repair:${artifact.id}:${artifact.version}`];
    return {
      id: `verification:safe-repair:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "reference-safe-repair-v1",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{ id: "safe-repair", status: "pass", evidenceRefs }],
      findingRefs: [],
      evidenceRefs,
      gapAssessments: (context?.gaps ?? []).map(gap => ({
        gapId: gap.id,
        status: "resolved" as const,
        evidenceRefs,
        confidence: 0.99,
        detail: "repair reconciled the ambiguous state without replaying the irreversible action"
      })),
      createdAt: new Date().toISOString()
    };
  }
}

test("Reference Mission fails closed on ambiguous side-effect completion and repairs without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-side-effect-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const planner = new AmbiguityPlanner();
  const driver = new AmbiguousThenSafeDriver(new FileArtifactStore(join(root, "artifacts")), root);
  const verifier = new SafeRepairVerifier();
  const controller = new MissionController(events, planner, driver, verifier, undefined, reader);
  const missionId = "reference-mission-side-effect-ambiguity";

  try {
    await controller.createMission(missionId, "Produce and safely launch the AI technology keynote exactly once.");

    const first = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
    assert.equal(first.status, "active");
    assert.deepEqual(driver.executedWorkIds, ["keynote-publish-once"]);
    assert.equal(driver.irreversibleInvocations, 1);
    assert.equal(verifier.calls, 0, "ambiguous execution artifacts must not be promoted into independent verification");

    let state = await controller.state(missionId);
    assert.equal(state.finalArtifactRefs.length, 0);
    assert.equal(state.blockingGapIds.length, 1);
    const firstJournal = await reader.journal(missionId);
    const ambiguityGap = [...firstJournal.gaps.values()].find(gap => gap.category === "runtime");
    assert.ok(ambiguityGap);
    assert.match(ambiguityGap!.description, /side-effect|ambiguous|unknown/i);
    assert.equal(firstJournal.workItems.get("keynote-publish-once")?.status, "failed");

    const second = await controller.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(second.status, "completed");
    assert.deepEqual(driver.executedWorkIds, ["keynote-publish-once", "keynote-reconcile-without-replay"]);
    assert.equal(driver.irreversibleInvocations, 1, "repair must not replay the irreversible action");
    assert.equal(verifier.calls, 1);
    assert.deepEqual(planner.diagnosisCalls, [ambiguityGap!.id]);

    state = await controller.state(missionId);
    assert.equal(state.status, "completed");
    assert.deepEqual(state.openGapIds, []);
    assert.deepEqual(state.blockingGapIds, []);
    assert.deepEqual(state.finalArtifactRefs, ["keynote@2"]);

    const after = await events.list(missionId);
    const firstTerminal = after.find(event =>
      event.type === "execution.completed" &&
      JSON.stringify(event.payload).includes("keynote-publish-once")
    );
    assert.ok(firstTerminal);
    assert.equal((firstTerminal!.payload as any).result.state, "partial");
    assert.match((firstTerminal!.payload as any).result.runtimeObservationRef ?? "", /side-effect/i);
    assert.equal((firstTerminal!.payload as any).result.sideEffects[0].status, "unknown");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
