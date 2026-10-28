import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionResult } from "../../src/core/domain/execution.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap } from "../../src/core/domain/verification.ts";
import {
  VerificationEvidenceCollectorRegistry,
  type VerificationEvidenceCollector
} from "../../src/core/verification/evidence-collector.ts";
import type { WorkExecutionDriver } from "../../src/core/execution/work-execution-driver.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

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
      ? "repair the evidence-confirmed presentation layout defect"
      : "produce the editable AI technology presentation",
    status: "proposed",
    requirementRefs: ["req-keynote"],
    gapRefs: [...gapRefs],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "keynote", type: "presentation", required: true }],
    localAcceptanceCriteria: [{
      id: "presentation-visual",
      description: "rendered slides have no material clipping or overflow",
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

class RenderRepairPlanner implements DeliberationProvider {
  diagnosisCalls: string[] = [];
  async composeStrategy() {
    return {
      framing: "produce and independently render-verify the keynote",
      approach: "render, detect material layout defects, repair and re-render",
      workstreams: [{ id: "keynote", objective: "deliver presentation" }],
      revision: 1
    };
  }
  async planFrontier(input: { state: MissionState; openGaps: Gap[] }) {
    if (input.openGaps.length === 0) {
      return { graphRevision: 1, capabilityNeeds: [], workItems: [work(input.state.missionId, "presentation-draft")] };
    }
    return {
      graphRevision: Math.max(2, input.state.graphRevision + 1),
      capabilityNeeds: [],
      workItems: [work(
        input.state.missionId,
        "presentation-layout-repair",
        input.openGaps.map(gap => gap.id).sort(),
        ["presentation-draft"]
      )]
    };
  }
  async diagnoseGap(input: { gap: Gap }) {
    this.diagnosisCalls.push(input.gap.id);
    assert.equal(input.gap.category, "quality");
    return {
      gapId: input.gap.id,
      rootCause: "render evidence identified slide overflow",
      intervention: "revise_work" as const,
      confidence: 1
    };
  }
  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}

class PresentationDriver implements WorkExecutionDriver {
  readonly id = "reference-presentation-driver";
  readonly executedWorkIds: string[] = [];
  private readonly artifacts: FileArtifactStore;
  private readonly root: string;

  constructor(artifacts: FileArtifactStore, root: string) {
    this.artifacts = artifacts;
    this.root = root;
  }

  async execute(input: any) {
    this.executedWorkIds.push(input.workItem.id);
    const source = join(this.root, `${input.workItem.id}.pptx`);
    const bad = input.workItem.id === "presentation-draft";
    await writeFile(
      source,
      bad
        ? "editable presentation fixture\nslide-3-footer-overflow=true\n"
        : "editable presentation fixture\nslide-3-footer-overflow=false\n",
      "utf8"
    );
    const artifact = this.artifacts.commit({
      missionId: input.workItem.missionId,
      logicalName: "keynote",
      type: "presentation",
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

class VersionedRenderCollector implements VerificationEvidenceCollector {
  readonly id = "reference-presentation-render";
  readonly kinds = ["file-integrity", "presentation-render"] as const;
  supports(input: any) { return input.artifact.type === "presentation"; }
  collect(input: any) {
    const bad = input.artifact.version === 1;
    return [
      {
        type: "file-validation" as const,
        kind: "file-integrity" as const,
        claim: "Committed presentation bytes are readable and match the candidate artifact.",
        result: "supports" as const
      },
      {
        type: "render-inspection" as const,
        kind: "presentation-render" as const,
        claim: bad
          ? "Rendered slide 3 exhibits material footer overflow beyond the safe slide boundary."
          : "Rendered slides, including slide 3, exhibit no material clipping or overflow.",
        result: "supports" as const,
        sourceRef: bad ? "render:slide-3:defect" : "render:slides:clean",
        details: { slideCount: 8, inspectedSlideRefs: ["slide-1", "slide-3", "slide-8"] },
        inspectionPayload: bad
          ? { slide: 3, issue: "footer-overflow", overflowPixels: 22 }
          : { slide: 3, issue: null, overflowPixels: 0 }
      }
    ];
  }
}

class RenderAwareHostReview implements HostJsonTransport {
  requests: HostJsonRequest[] = [];
  async request(input: HostJsonRequest) {
    this.requests.push(input);
    const payload = input.input as any;
    const render = payload.runtimeEvidence.find((item: any) => item.kind === "presentation-render");
    const refs = payload.runtimeEvidence.map((item: any) => item.id);
    const bad = String(render?.claim ?? "").includes("material footer overflow");
    return {
      overall: bad ? "fail" : "pass",
      checkResults: payload.verificationProfile.checks.map((check: any) => ({
        id: check.id,
        status: bad && check.id === "presentation-visual-quality" ? "fail" : "pass",
        detail: bad && check.id === "presentation-visual-quality"
          ? "Slide 3 footer is visibly clipped in the registered render inspection."
          : "Registered render/file evidence supports this required check.",
        evidenceRefs: refs
      })),
      evidenceRefs: refs,
      gapAssessments: payload.gaps.map((gap: any) => ({
        gapId: gap.id,
        status: bad ? "still_open" : "resolved",
        evidenceRefs: [render.id],
        confidence: 1,
        detail: bad ? "render defect remains" : "replacement render confirms the layout defect is repaired"
      }))
    };
  }
}

test("Reference Mission repairs a render-confirmed presentation layout defect before final promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-reference-render-defect-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const planner = new RenderRepairPlanner();
  const driver = new PresentationDriver(new FileArtifactStore(join(root, "artifacts")), root);
  const review = new RenderAwareHostReview();
  const verifier = new HostArtifactVerifier({
    transport: review,
    events,
    reader,
    evidenceCollectors: new VerificationEvidenceCollectorRegistry([new VersionedRenderCollector()])
  });
  const controller = new MissionController(events, planner, driver, verifier, undefined, reader);
  const missionId = "reference-mission-render-defect";

  try {
    await controller.createMission(missionId, "Produce an editable AI technology presentation with strong rendered visual quality.");

    const first = await controller.runControllerCycle({ missionId, trigger: "mission_created" });
    assert.equal(first.status, "active");
    assert.deepEqual(driver.executedWorkIds, ["presentation-draft"]);
    let state = await controller.state(missionId);
    assert.deepEqual(state.finalArtifactRefs, []);
    assert.equal(state.blockingGapIds.length, 1);

    const firstEvidence = reader.readEvidence(missionId, "keynote@1");
    const defectEvidence = firstEvidence.find(item => item.kind === "presentation-render");
    assert.ok(defectEvidence);
    assert.match(defectEvidence!.claim, /slide 3.*overflow/i);
    const firstJournal = await reader.journal(missionId);
    assert.equal(firstJournal.artifacts.get("keynote@1")?.status, "invalid");
    const qualityGap = [...firstJournal.gaps.values()].find(gap => gap.category === "quality");
    assert.ok(qualityGap);

    const second = await controller.runControllerCycle({ missionId, trigger: "verification_event" });
    assert.equal(second.status, "completed");
    assert.deepEqual(driver.executedWorkIds, ["presentation-draft", "presentation-layout-repair"]);
    assert.deepEqual(planner.diagnosisCalls, [qualityGap!.id]);

    state = await controller.state(missionId);
    assert.deepEqual(state.finalArtifactRefs, ["keynote@2"]);
    assert.deepEqual(state.openGapIds, []);
    assert.deepEqual(state.blockingGapIds, []);
    const completedJournal = await reader.journal(missionId);
    assert.equal(completedJournal.workItems.get("presentation-draft")?.status, "superseded");
    assert.equal(completedJournal.artifacts.get("keynote@1")?.status, "invalid");
    assert.equal(completedJournal.artifacts.get("keynote@2")?.status, "final");

    const repairedEvidence = reader.readEvidence(missionId, "keynote@2");
    const cleanRender = repairedEvidence.find(item => item.kind === "presentation-render");
    assert.ok(cleanRender);
    assert.match(cleanRender!.claim, /no material clipping or overflow/i);
    assert.equal(review.requests.length, 2);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
