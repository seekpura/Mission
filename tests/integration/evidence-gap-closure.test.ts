import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { GapAssessment, VerificationResult } from "../../src/core/domain/verification.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { VerificationContext, Verifier } from "../../src/core/verification/verifier.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";

const missionId = "mission-gap-evidence";

class ArtifactDriver implements WorkExecutionDriver {
  readonly id = "artifact-driver";
  private readonly logicalNames: string[];

  constructor(logicalNames: string[] = ["repair-output"]) {
    this.logicalNames = logicalNames;
  }

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const now = new Date().toISOString();
    const artifacts: Artifact[] = this.logicalNames.map((logicalName, index) => ({
      id: logicalName,
      missionId: input.workItem.missionId,
      logicalName,
      type: "document",
      version: 1,
      status: "candidate",
      uri: `/tmp/${logicalName}.txt`,
      contentHash: `hash-${index}`,
      sizeBytes: 10,
      producedByAttemptId: input.attemptId,
      sourceArtifactRefs: [],
      createdAt: now
    }));
    return {
      result: {
        executionId: input.executionId,
        state: "succeeded",
        producedFiles: artifacts.map(artifact => ({
          path: artifact.uri,
          logicalName: artifact.logicalName,
          type: artifact.type
        })),
        committedArtifactRefs: artifacts.map(artifact => `${artifact.id}@${artifact.version}`),
        sideEffects: [],
        startedAt: now,
        endedAt: now
      },
      artifacts
    };
  }
}

class GapAwareVerifier implements Verifier {
  readonly id = "gap-aware-verifier";
  readonly contexts: VerificationContext[] = [];
  private readonly assess: (artifact: Artifact, context: VerificationContext) => GapAssessment[];
  private readonly overall: VerificationResult["overall"];

  constructor(
    assess: (artifact: Artifact, context: VerificationContext) => GapAssessment[],
    overall: VerificationResult["overall"] = "pass"
  ) {
    this.assess = assess;
    this.overall = overall;
  }

  async verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult> {
    assert.ok(context);
    this.contexts.push(context!);
    return {
      id: `verification-${artifact.id}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "repair-quality",
      verifierId: this.id,
      level: "quality",
      overall: this.overall,
      checkResults: [
        {
          id: "repair-check",
          status: this.overall === "pass" ? "pass" : "fail",
          detail: "Independent repair validation",
          evidenceRefs: [`check-evidence-${artifact.id}`]
        }
      ],
      findingRefs: [],
      evidenceRefs: [`verification-evidence-${artifact.id}`],
      gapAssessments: this.assess(artifact, context!),
      createdAt: new Date().toISOString()
    };
  }
}

function createStore() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  return { db, store: new SqliteEventStore(db) };
}

async function seedRepair(controller: MissionController, outputNames = ["repair-output"]) {
  await controller.createMission(missionId, "Repair an independently verified gap");
  await controller.openGap(missionId, {
    id: "gap-quality",
    severity: "major",
    description: "Existing candidate failed quality verification",
    blocking: true,
    category: "quality",
    requirementRefs: ["req-quality"],
    artifactRefs: ["old@1"]
  });
  const now = new Date().toISOString();
  await controller.proposeWork({
    id: "repair-work",
    missionId,
    purpose: "repair",
    objective: "Repair the quality gap",
    status: "ready",
    requirementRefs: ["req-quality"],
    gapRefs: ["gap-quality"],
    inputArtifactRefs: ["old@1"],
    expectedOutputs: outputNames.map(logicalName => ({ logicalName, type: "document", required: true })),
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: 10,
    graphRevision: 1,
    createdBy: "replanner",
    createdAt: now,
    updatedAt: now
  });
}

function resolvedAssessment(detail = "The repaired artifact addresses the quality defect"): GapAssessment[] {
  return [{
    gapId: "gap-quality",
    status: "resolved",
    detail,
    evidenceRefs: ["gap-evidence-1"],
    confidence: 0.98
  }];
}

test("gap closes only after a passing independent verifier explicitly assesses it as resolved", async () => {
  const { db, store } = createStore();
  const verifier = new GapAwareVerifier(() => resolvedAssessment());
  const controller = new MissionController(store, undefined, new ArtifactDriver(), verifier);

  try {
    await seedRepair(controller);
    await controller.runControllerCycle({ missionId, trigger: "manual" });

    const state = await controller.state(missionId);
    assert.deepEqual(state.openGapIds, []);
    assert.deepEqual(state.blockingGapIds, []);
    assert.equal(verifier.contexts.length, 1);
    assert.deepEqual(verifier.contexts[0]?.gaps.map(gap => gap.id), ["gap-quality"]);

    const events = await store.list(missionId);
    const resolved = events.find(event => event.type === "gap.resolved");
    assert.ok(resolved);
    const payload = resolved!.payload as any;
    assert.equal(payload.id, "gap-quality");
    assert.deepEqual(payload.verificationRefs, ["verification-repair-output"]);
    assert.deepEqual(payload.artifactRefs, ["repair-output@1"]);
    assert.equal(payload.evidenceRefs.includes("gap-evidence-1"), true);
    assert.equal(payload.evidenceRefs.includes("verification-evidence-repair-output"), true);

    const types = events.map(event => event.type);
    assert.ok(types.indexOf("verification.completed") < types.indexOf("gap.resolved"));
    assert.ok(types.indexOf("gap.resolved") < types.indexOf("work.completed"));
  } finally {
    db.close();
  }
});

test("a passing verifier without a gap assessment does not close the gap", async () => {
  const { db, store } = createStore();
  const controller = new MissionController(
    store,
    undefined,
    new ArtifactDriver(),
    new GapAwareVerifier(() => [])
  );

  try {
    await seedRepair(controller);
    await controller.runControllerCycle({ missionId, trigger: "manual" });

    const state = await controller.state(missionId);
    assert.deepEqual(state.openGapIds, ["gap-quality"]);
    assert.deepEqual(state.blockingGapIds, ["gap-quality"]);
    const types = (await store.list(missionId)).map(event => event.type);
    assert.equal(types.includes("gap.resolved"), false);
    assert.equal(types.includes("work.completed"), true);
  } finally {
    db.close();
  }
});

test("conflicting gap assessments across passing artifacts keep the gap open", async () => {
  const { db, store } = createStore();
  const verifier = new GapAwareVerifier(artifact => artifact.id === "repair-a"
    ? resolvedAssessment("Artifact A verifies the repair")
    : [{
        gapId: "gap-quality",
        status: "still_open",
        detail: "Artifact B still exposes the defect",
        evidenceRefs: ["gap-evidence-negative"],
        confidence: 0.95
      }]);
  const controller = new MissionController(
    store,
    undefined,
    new ArtifactDriver(["repair-a", "repair-b"]),
    verifier
  );

  try {
    await seedRepair(controller, ["repair-a", "repair-b"]);
    await controller.runControllerCycle({ missionId, trigger: "manual" });

    const state = await controller.state(missionId);
    assert.deepEqual(state.openGapIds, ["gap-quality"]);
    const types = (await store.list(missionId)).map(event => event.type);
    assert.equal(types.includes("gap.resolved"), false);
    assert.equal(types.includes("work.completed"), true);
  } finally {
    db.close();
  }
});

test("a failing verifier cannot close a gap even if it claims resolved", async () => {
  const { db, store } = createStore();
  const controller = new MissionController(
    store,
    undefined,
    new ArtifactDriver(),
    new GapAwareVerifier(() => resolvedAssessment(), "fail")
  );

  try {
    await seedRepair(controller);
    await controller.runControllerCycle({ missionId, trigger: "manual" });

    const state = await controller.state(missionId);
    assert.equal(state.openGapIds.includes("gap-quality"), true);
    const types = (await store.list(missionId)).map(event => event.type);
    assert.equal(types.includes("gap.resolved"), false);
    assert.equal(types.includes("work.failed"), true);
  } finally {
    db.close();
  }
});

test("a verifier cannot assess a gap that is not open and attached to the current work", async () => {
  const { db, store } = createStore();
  const verifier = new GapAwareVerifier(() => [{
    gapId: "gap-unrelated",
    status: "resolved",
    detail: "Attempted unrelated resolution",
    evidenceRefs: [],
    confidence: 1
  }]);
  const controller = new MissionController(store, undefined, new ArtifactDriver(), verifier);

  try {
    await seedRepair(controller);
    await controller.runControllerCycle({ missionId, trigger: "manual" });

    const state = await controller.state(missionId);
    assert.equal(state.openGapIds.includes("gap-quality"), true);
    assert.equal(state.blockingGapIds.some(id => id.startsWith("verification-gap:")), true);
    assert.deepEqual(state.verifyingWorkItemIds, []);

    const completed = (await store.list(missionId)).find(event =>
      event.type === "verification.completed" && (event.payload as any)?.overall === "inconclusive"
    );
    assert.match((completed?.payload as any)?.error ?? "", /unrelated or closed gap/);
  } finally {
    db.close();
  }
});
