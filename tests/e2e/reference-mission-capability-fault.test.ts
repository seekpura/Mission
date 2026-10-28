import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { ExecutionResult } from "../../src/core/domain/execution.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap, VerificationResult } from "../../src/core/domain/verification.ts";
import type { CapabilityRuntime, CapabilityEnsureResult } from "../../src/core/capabilities/capability-coordinator.ts";
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

function capabilityNeed(missionId: string): CapabilityNeed {
  return {
    id: "need-keynote-motion",
    missionId,
    objective: "render supporting keynote motion",
    requiredFunctions: ["presentation.motion.render"],
    desiredInputs: ["presentation"],
    desiredOutputs: ["video"],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: ["req-keynote-motion"],
    gapRefs: []
  };
}

function work(
  missionId: string,
  id: string,
  gapRefs: string[],
  capabilityNeedRefs: string[]
): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: gapRefs.length > 0 ? "repair" : "production",
    objective: gapRefs.length > 0
      ? "deliver a fallback keynote package without the failed external motion capability"
      : "deliver the keynote package using the requested motion capability",
    status: "proposed",
    requirementRefs: ["req-keynote-deliverable"],
    gapRefs: [...gapRefs],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "file", required: true }],
    localAcceptanceCriteria: [{
      id: "keynote-fallback",
      description: "a non-empty editable keynote deliverable exists even when optional motion acquisition fails",
      priority: "critical"
    }],
    capabilityNeedRefs: [...capabilityNeedRefs],
    priority: 100,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

class FailingAcquisitionRuntime implements CapabilityRuntime {
  ensureCalls: string[] = [];

  restoreMissionCapabilities() {}
  deactivateMissionCapability() {}

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    this.ensureCalls.push(need.id);
    return {
      status: "acquisition_failed",
      source: "none",
      attempts: [{
        candidateId: "candidate-motion-plugin",
        candidateName: "Motion Plugin Candidate",
        ok: false,
        reason: "injected functional smoke failure"
      }],
      reason: "all discovered motion candidates failed isolated functional smoke validation"
    };
  }
}

class CapabilityFallbackPlanner implements DeliberationProvider {
  frontierCalls = 0;
  diagnosisCalls: string[] = [];

  async composeStrategy() {
    return {
      framing: "prefer rich motion but preserve the final keynote goal through a safe fallback",
      approach: "attempt capability, diagnose failure, then replan without it",
      workstreams: [{ id: "keynote", objective: "deliver the keynote" }],
      revision: 1
    };
  }

  async planFrontier(input: { state: any; openGaps: Gap[] }) {
    this.frontierCalls += 1;
    if (input.openGaps.length === 0) {
      const need = capabilityNeed(input.state.missionId);
      return {
        graphRevision: 1,
        capabilityNeeds: [need],
        workItems: [work(input.state.missionId, "keynote-with-motion", [], [need.id])]
      };
    }
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(
        input.state.missionId,
        "keynote-safe-fallback",
        input.openGaps.map(gap => gap.id).sort(),
        []
      )]
    };
  }

  async diagnoseGap(input: { gap: Gap }) {
    this.diagnosisCalls.push(input.gap.id);
    assert.equal(input.gap.category, "capability");
    return {
      gapId: input.gap.id,
      rootCause: "external motion capability candidates are unusable under current trust/isolation policy",
      intervention: "revise_work" as const,
      confidence: 0.99
    };
  }

  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 0.99 };
  }
}

class FallbackDriver implements WorkExecutionDriver {
  readonly id = "reference-capability-fallback-driver";
  executedWorkIds: string[] = [];
  private readonly artifacts: FileArtifactStore;
  private readonly root: string;

  constructor(artifacts: FileArtifactStore, root: string) {
    this.artifacts = artifacts;
    this.root = root;
  }

  async execute(input: any) {
    this.executedWorkIds.push(input.workItem.id);
    const source = join(this.root, `${input.workItem.id}.txt`);
    await writeFile(source, "editable keynote fallback without externally acquired motion\n", "utf8");
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

class CapabilityFallbackVerifier implements Verifier {
  readonly id = "reference-capability-fallback-verifier";

  async verify(artifact: any, context?: VerificationContext): Promise<VerificationResult> {
    const evidenceRefs = [`evidence:fallback:${artifact.id}:${artifact.version}`];
    return {
      id: `verification:fallback:${artifact.id}:${artifact.version}`,
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "reference-keynote-fallback-v1",
      verifierId: this.id,
      level: "mission",
      overall: "pass",
      checkResults: [{
        id: "fallback-deliverable",
        status: "pass",
        evidenceRefs,
        detail: "fallback deliverable remains usable and satisfies the required final artifact contract"
      }],
      findingRefs: [],
      evidenceRefs,
      gapAssessments: (context?.gaps ?? []).map(gap => ({
        gapId: gap.id,
        status: "resolved" as const,
        evidenceRefs,
        confidence: 0.99,
        detail: "fallback work removes the blocked capability dependency while preserving the final deliverable"
      })),
      createdAt: new Date().toISOString()
    };
  }
}

test("Reference Mission replans around failed capability acquisition instead of retrying blocked Work", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-capability-fault-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const planner = new CapabilityFallbackPlanner();
  const capabilities = new FailingAcquisitionRuntime();
  const driver = new FallbackDriver(new FileArtifactStore(join(root, "artifacts")), root);
  const verifier = new CapabilityFallbackVerifier();
  const controller = new MissionController(events, planner, driver, verifier, capabilities, reader);
  const missionId = "reference-mission-capability-failure";

  try {
    await controller.createMission(
      missionId,
      "Produce the AI technology keynote; use supporting motion when a safe working capability is available."
    );

    const first = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
    assert.equal(first.status, "active");
    assert.deepEqual(capabilities.ensureCalls, ["need-keynote-motion"]);
    assert.deepEqual(driver.executedWorkIds, []);

    let state = await controller.state(missionId);
    assert.deepEqual(state.blockedWorkItemIds, ["keynote-with-motion"]);
    assert.equal(state.blockingGapIds.length, 1);
    assert.equal(state.finalArtifactRefs.length, 0);

    const journal = await reader.journal(missionId);
    const capabilityGap = [...journal.gaps.values()].find(gap => gap.category === "capability");
    assert.ok(capabilityGap);
    assert.match(capabilityGap!.description, /could not be resolved/);
    assert.match(capabilityGap!.description, /failed isolated functional smoke validation|failed isolated functional smoke|all discovered motion candidates/);

    const second = await controller.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(second.status, "completed");
    assert.deepEqual(capabilities.ensureCalls, ["need-keynote-motion"]);
    assert.deepEqual(driver.executedWorkIds, ["keynote-safe-fallback"]);
    assert.deepEqual(planner.diagnosisCalls, [capabilityGap!.id]);

    state = await controller.state(missionId);
    assert.equal(state.status, "completed");
    assert.deepEqual(state.blockingGapIds, []);
    assert.deepEqual(state.openGapIds, []);
    assert.deepEqual(state.finalArtifactRefs, ["keynote@1"]);

    const after = await events.list(missionId);
    const blockedIndex = after.findIndex(event => event.type === "work.blocked");
    const gapIndex = after.findIndex((event, index) => index > blockedIndex && event.type === "gap.opened");
    const diagnosisIndex = after.findIndex((event, index) => index > gapIndex && event.type === "decision.created");
    const fallbackIndex = after.findIndex((event, index) =>
      index > diagnosisIndex && event.type === "work.created" && (event.payload as { id?: string }).id === "keynote-safe-fallback"
    );
    const resolvedIndex = after.findIndex((event, index) => index > fallbackIndex && event.type === "gap.resolved");
    const completedIndex = after.findIndex((event, index) => index > resolvedIndex && event.type === "mission.completed");
    assert.ok(blockedIndex >= 0);
    assert.ok(gapIndex > blockedIndex);
    assert.ok(diagnosisIndex > gapIndex);
    assert.ok(fallbackIndex > diagnosisIndex);
    assert.ok(resolvedIndex > fallbackIndex);
    assert.ok(completedIndex > resolvedIndex);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
