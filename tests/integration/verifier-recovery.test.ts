import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { VerificationResult } from "../../src/core/domain/verification.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { Verifier } from "../../src/core/verification/verifier.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";

class SuccessfulDriver implements WorkExecutionDriver {
  readonly id = "successful-driver";

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    const now = new Date().toISOString();
    const artifact: Artifact = {
      id: "deliverable",
      missionId: input.workItem.missionId,
      logicalName: "deliverable",
      type: "document",
      version: 1,
      status: "candidate",
      uri: "/tmp/deliverable.txt",
      contentHash: "test-hash",
      sizeBytes: 10,
      producedByAttemptId: input.attemptId,
      sourceArtifactRefs: [],
      createdAt: now
    };
    return {
      result: {
        executionId: input.executionId,
        state: "succeeded",
        producedFiles: [{ path: artifact.uri, logicalName: artifact.logicalName, type: artifact.type }],
        committedArtifactRefs: ["deliverable@1"],
        sideEffects: [],
        startedAt: now,
        endedAt: now
      },
      artifacts: [artifact]
    };
  }
}

class WrongIdentityVerifier implements Verifier {
  readonly id = "wrong-identity-verifier";

  async verify(_artifact: Artifact): Promise<VerificationResult> {
    return {
      id: "bad-verification",
      missionId: "wrong-mission",
      artifactRef: "wrong-artifact@99",
      verificationProfileId: "test",
      verifierId: this.id,
      level: "structural",
      overall: "pass",
      checkResults: [],
      findingRefs: [],
      evidenceRefs: [],
      createdAt: new Date().toISOString()
    };
  }
}

test("verifier identity mismatch becomes a blocking runtime gap instead of leaving work verifying", async () => {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const store = new SqliteEventStore(db);
  const controller = new MissionController(
    store,
    undefined,
    new SuccessfulDriver(),
    new WrongIdentityVerifier()
  );

  try {
    await controller.createMission("mission-verifier-recovery", "produce one independently verified document");
    const now = new Date().toISOString();
    await controller.proposeWork({
      id: "work-1",
      missionId: "mission-verifier-recovery",
      purpose: "production",
      objective: "produce the document",
      status: "ready",
      requirementRefs: ["req-1"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      priority: 1,
      graphRevision: 0,
      createdBy: "planner",
      createdAt: now,
      updatedAt: now
    });

    const cycle = await controller.runControllerCycle({
      missionId: "mission-verifier-recovery",
      trigger: "manual"
    });
    assert.equal(cycle.status, "active");

    const state = await controller.state("mission-verifier-recovery");
    assert.deepEqual(state.verifyingWorkItemIds, []);
    assert.deepEqual(state.activeWorkItemIds, []);
    assert.equal(state.blockingGapIds.length, 1);
    assert.match(state.blockingGapIds[0] ?? "", /^verification-gap:/);

    const events = await store.list("mission-verifier-recovery");
    const types = events.map(event => event.type);
    assert.ok(types.includes("verification.started"));
    assert.ok(types.includes("verification.completed"));
    assert.ok(types.includes("gap.opened"));
    assert.ok(types.includes("work.failed"));
    assert.equal(types.includes("mission.completed"), false);

    const completed = events.find(event => event.type === "verification.completed");
    assert.equal((completed?.payload as any)?.overall, "inconclusive");
    assert.match((completed?.payload as any)?.error ?? "", /mismatched identity/);
  } finally {
    db.close();
  }
});
