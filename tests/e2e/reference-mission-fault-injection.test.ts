import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { AgentCreateRequest } from "../../src/hosts/deepseek/host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { InspectionProvider } from "../../src/core/inspection/inspection-provider.ts";
import { SecureAcquisitionService } from "../../src/core/capabilities/secure-acquisition-service.ts";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";
import { CapabilitySmokeTester } from "../../src/core/capabilities/sandbox/smoke-tester.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import { WORKER_RECOVERY_FILE } from "../../src/core/execution/worker-output.ts";

const R_SOURCE = "R-SOURCE";
const R_DECK = "R-DECK";
const R_NOTES = "R-NOTES";
const R_MOTION = "R-MOTION";
const R_BUNDLE = "R-BUNDLE";

class KeynoteRenderInspectionProvider implements InspectionProvider {
  id = "fixture-keynote-renderer";
  version = "1";
  supports(artifact: any, request: any): boolean {
    return artifact.type === "presentation" && request.kind === "page-render";
  }
  async inspect(artifact: any, _request: any, context: any) {
    const path = join(context.outputDir, `slide-${artifact.version}.png`);
    writeFileSync(path, `rendered deck ${artifact.version}`, "utf8");
    return {
      providerId: this.id,
      providerVersion: this.version,
      sourceArtifactRef: `${artifact.id}@${artifact.version}`,
      products: [{ kind: "page-render" as const, path, type: "image" as const, logicalSuffix: `slide-${artifact.version}`, mimeType: "image/png" }]
    };
  }
}

function gitRepo(root: string, name: string, files: Record<string, string>): string {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  for (const [file, body] of Object.entries(files)) {
    writeFileSync(join(repo, file), body, "utf8");
  }
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

function makeWork(state: MissionState, input: {
  id: string;
  purpose?: WorkItem["purpose"];
  objective: string;
  requirements: string[];
  output?: { logicalName: string; type: string };
  dependencies?: WorkItem["artifactDependencies"];
  capabilityNeedRefs?: string[];
  priority: number;
}): WorkItem {
  const now = new Date().toISOString();
  return {
    id: input.id,
    missionId: state.missionId,
    workstreamId: "keynote",
    purpose: input.purpose ?? "production",
    objective: input.objective,
    status: "ready",
    requirementRefs: input.requirements,
    gapRefs: [],
    inputArtifactRefs: [],
    artifactDependencies: input.dependencies,
    expectedOutputs: input.output ? [{ logicalName: input.output.logicalName, type: input.output.type, required: true }] : [],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: input.capabilityNeedRefs ?? [],
    priority: input.priority,
    graphRevision: state.graphRevision + 1,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function referenceProvider() {
  let initialPlanned = false;
  let secondWavePlanned = false;
  let steered = false;
  let steeredWavePlanned = false;

  const provider: DeliberationProvider = {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      const requirements = [
        { id: R_SOURCE, description: "Keynote claims have a current source record", type: "evidence" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: R_DECK, description: "Editable keynote deck has presentation-scale visual quality without overflow", type: "visual" as const, priority: "required" as const, verification: "review" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: R_NOTES, description: "Speaker notes form a coherent 45-minute technical narrative", type: "content" as const, priority: "required" as const, verification: "review" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: R_MOTION, description: "Supporting motion asset exists and is usable", type: "functional" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] },
        { id: R_BUNDLE, description: "Final keynote package is integrated", type: "functional" as const, priority: "required" as const, verification: "artifact" as const, status: "unverified" as const, evidenceRefs: [] }
      ];
      return {
        missionSpec: {
          missionId,
          revision: 1,
          objective: userGoal,
          intent: "45-minute high-production AI technology keynote",
          requestedOutputs: ["source-record", "deck", "speaker-notes", "motion", "final-bundle"],
          constraints: ["editable deck", "current reliable sources"],
          preferences: ["high-production technical keynote"],
          sourceRefs: [],
          createdAt: now
        },
        acceptanceContract: {
          missionId,
          revision: 1,
          requirements,
          requiredArtifacts: [
            { logicalName: "source-record", type: "document", requirementRefs: [R_SOURCE] },
            { logicalName: "deck", type: "presentation", requirementRefs: [R_DECK] },
            { logicalName: "speaker-notes", type: "document", requirementRefs: [R_NOTES] },
            { logicalName: "motion", type: "video", requirementRefs: [R_MOTION] },
            { logicalName: "final-bundle", type: "document", requirementRefs: [R_BUNDLE] }
          ],
          requiredValidations: [{
            id: "bundle-integration",
            description: "Deck, notes, motion, source record and media manifest form one usable package",
            level: "integration",
            requirementRefs: [R_BUNDLE],
            integration: {
              mode: "artifacts-present",
              artifactLogicalNames: ["deck", "speaker-notes", "motion", "source-record", "media-manifest", "final-bundle"]
            }
          }],
          criticalFailureConditions: ["stale key source", "broken deck visual layout", "missing integrated media"],
          createdAt: now
        }
      };
    },
    async composeStrategy() {
      return {
        framing: "evidence-backed staged keynote production",
        approach: "research first, visually verify deck, then notes/motion/integration with repair loops",
        workstreams: [{ id: "keynote", objective: "produce and validate the complete keynote package" }],
        revision: 1
      };
    },
    async planFrontier({ state }) {
      if (!initialPlanned) {
        initialPlanned = true;
        return {
          graphRevision: state.graphRevision + 1,
          workItems: [
            makeWork(state, {
              id: "research-source",
              objective: "research current AI evidence and produce the source record",
              requirements: [R_SOURCE],
              output: { logicalName: "source-record", type: "document" },
              priority: 100
            }),
            makeWork(state, {
              id: "deck-initial",
              objective: "produce editable keynote deck from the verified source record",
              requirements: [R_DECK],
              output: { logicalName: "deck", type: "presentation" },
              dependencies: [{ logicalName: "source-record", type: "document", minimumStatus: "final" }],
              priority: 95
            })
          ]
        };
      }

      if (!steered && !secondWavePlanned) {
        secondWavePlanned = true;
        return {
          graphRevision: state.graphRevision + 1,
          capabilityNeeds: [{
            id: "need-motion",
            missionId: state.missionId,
            objective: "motion animation rendering for keynote media",
            requiredFunctions: ["motion", "animation", "rendering"],
            desiredInputs: ["deck"],
            desiredOutputs: ["video"],
            purpose: "production",
            urgency: "blocking",
            acquisitionAllowed: true,
            maxRisk: "medium",
            requirementRefs: [R_MOTION],
            gapRefs: [],
            status: "checking-installed"
          }],
          workItems: downstreamWave(state, "presteer")
        };
      }

      if (steered && !steeredWavePlanned) {
        steeredWavePlanned = true;
        return {
          graphRevision: state.graphRevision + 1,
          workItems: [
            makeWork(state, {
              id: "deck-steered",
              objective: "rebuild deck for a deeper technical launch-keynote direction while preserving verified claims",
              requirements: [R_DECK],
              output: { logicalName: "deck", type: "presentation" },
              dependencies: [{ logicalName: "source-record", type: "document", minimumStatus: "final" }],
              priority: 110
            }),
            ...downstreamWave(state, "steered")
          ]
        };
      }

      return { graphRevision: state.graphRevision, workItems: [] };
    },
    async interpretSteering() {
      steered = true;
      return {
        kind: "semantic",
        reason: "User changed the deck to a deeper technical launch-keynote direction",
        confidence: 1,
        specPatch: { preferences: ["deeper technical narrative", "launch-keynote visual language"] },
        affectedRequirementRefs: [R_DECK],
        affectedWorkItemRefs: [],
        affectedArtifactRefs: [],
        strategyImpact: "local"
      };
    },
    async diagnoseGap({ gap }) {
      return {
        gapId: gap.id,
        rootCause: gap.description,
        intervention: "revise_work",
        repairScope: "work_item",
        confidence: 1,
        hypotheses: [{ statement: gap.description, confidence: 1, findingRefs: [], evidenceRefs: [] }]
      };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    }
  };
  return provider;
}

function downstreamWave(state: MissionState, suffix: string): WorkItem[] {
  const deck = { logicalName: "deck", type: "presentation", minimumStatus: "final" as const };
  const source = { logicalName: "source-record", type: "document", minimumStatus: "final" as const };
  return [
    makeWork(state, {
      id: `notes-${suffix}`,
      objective: "write coherent 45-minute speaker notes for the current verified deck",
      requirements: [R_NOTES],
      output: { logicalName: "speaker-notes", type: "document" },
      dependencies: [deck, source],
      priority: 90
    }),
    makeWork(state, {
      id: `motion-${suffix}`,
      objective: "render supporting keynote motion media with the resolved motion capability",
      requirements: [R_MOTION],
      output: { logicalName: "motion", type: "video" },
      dependencies: [deck],
      capabilityNeedRefs: ["need-motion"],
      priority: 80
    }),
    makeWork(state, {
      id: `integrate-${suffix}`,
      purpose: "integration",
      objective: "integrate deck, notes, motion and sources into the final keynote bundle",
      requirements: [R_BUNDLE],
      output: { logicalName: "final-bundle", type: "document" },
      dependencies: [
        deck,
        source,
        { logicalName: "speaker-notes", type: "document", minimumStatus: "final" },
        { logicalName: "motion", type: "video", minimumStatus: "final" }
      ],
      priority: 70
    })
  ];
}

function workerEnvelope(request: AgentCreateRequest) {
  const context = request.context as any;
  const objective = String(context?.contextPacket?.objective ?? "");
  const workspace = request.workspaceRoot!;
  const base = { proposedWork: [], warnings: [] as string[] };

  if (request.workItemId === "research-source") {
    writeFileSync(join(workspace, "sources.md"), "Current AI benchmark evidence from the primary source.", "utf8");
    return {
      status: "completed",
      summary: "current source record",
      outputs: [{ path: "sources.md", logicalName: "source-record", type: "document", requirementRefs: [R_SOURCE] }],
      sources: [{ id: "source-old", type: "web", uri: "https://example.test/ai-benchmark", title: "AI benchmark", capturedAt: new Date().toISOString(), freshUntil: "2099-01-01T00:00:00.000Z", authority: "primary" }],
      proposedFacts: [{ key: "ai.benchmark.score", value: 87, sourceRefs: ["source-old"], requirementRefs: [R_SOURCE, R_DECK] }],
      ...base
    };
  }

  if (request.workItemId === "deck-initial") {
    writeFileSync(join(workspace, "keynote.pptx"), "deck-v1-overflow", "utf8");
    return {
      status: "completed",
      summary: "initial deck",
      outputs: [{ path: "keynote.pptx", logicalName: "deck", type: "presentation", requirementRefs: [R_DECK] }],
      proposedFacts: [{ key: "deck.ai.benchmark.score", value: 87, sourceRefs: ["source-old"], requirementRefs: [R_DECK] }],
      ...base
    };
  }

  const invalidated = context?.invalidatedKnowledge ?? { truths: [], sources: [] };
  if (request.workItemId.startsWith("repair-") && (invalidated.sources ?? []).some((source: any) => source.id === "source-old")) {
    writeFileSync(join(workspace, "sources-refreshed.md"), "Refreshed AI benchmark evidence.", "utf8");
    writeFileSync(join(workspace, "keynote-refreshed.pptx"), "deck-refreshed-source", "utf8");
    const staleTruths = (invalidated.truths ?? []).filter((truth: any) => (truth.sourceRefs ?? []).includes("source-old"));
    return {
      status: "completed",
      summary: "refreshed stale source and rebound all dependent facts",
      outputs: [
        { path: "sources-refreshed.md", logicalName: "source-record", type: "document", requirementRefs: [R_SOURCE] },
        { path: "keynote-refreshed.pptx", logicalName: "deck", type: "presentation", requirementRefs: [R_DECK] }
      ],
      sources: [{ id: "source-new", type: "web", uri: "https://example.test/ai-benchmark-v2", title: "AI benchmark refreshed", capturedAt: new Date().toISOString(), freshUntil: "2099-01-01T00:00:00.000Z", authority: "primary", replacesSourceRef: "source-old" }],
      proposedFacts: staleTruths.map((truth: any, index: number) => ({
        key: `${truth.key}.refresh.${index + 1}`,
        value: truth.value,
        sourceRefs: ["source-new"],
        requirementRefs: truth.requirementRefs ?? [],
        supersedesTruthRef: truth.id
      })),
      ...base
    };
  }

  if (request.workItemId.startsWith("repair-")) {
    writeFileSync(join(workspace, "keynote-repaired.pptx"), "deck-v2-repaired", "utf8");
    return {
      status: "completed",
      summary: "repaired deck overflow",
      outputs: [{ path: "keynote-repaired.pptx", logicalName: "deck", type: "presentation", requirementRefs: [R_DECK] }],
      proposedFacts: [{ key: "deck.ai.benchmark.score", value: 87, sourceRefs: ["source-old"], requirementRefs: [R_DECK] }],
      ...base
    };
  }

  if (request.workItemId === "deck-steered") {
    writeFileSync(join(workspace, "keynote-steered.pptx"), "deck-v3-deeper-technical", "utf8");
    return {
      status: "completed",
      summary: "steered technical deck",
      outputs: [{ path: "keynote-steered.pptx", logicalName: "deck", type: "presentation", requirementRefs: [R_DECK] }],
      proposedFacts: [{ key: "deck.ai.benchmark.score", value: 87, sourceRefs: ["source-old"], requirementRefs: [R_DECK] }],
      ...base
    };
  }

  if (request.workItemId.startsWith("notes-")) {
    writeFileSync(join(workspace, "speaker-notes.md"), "45 minute technical speaker narrative", "utf8");
    return {
      status: "completed",
      summary: "speaker notes",
      outputs: [{ path: "speaker-notes.md", logicalName: "speaker-notes", type: "document", requirementRefs: [R_NOTES] }],
      proposedFacts: [],
      ...base
    };
  }

  if (request.workItemId.startsWith("motion-")) {
    assert.equal(request.allowedCapabilityRefs.length, 1, "motion work must receive the acquired mission-local capability");
    assert.equal((context.capabilities ?? []).length, 1);
    writeFileSync(join(workspace, "motion.mp4"), "motion-media", "utf8");
    return {
      status: "completed",
      summary: "motion media",
      outputs: [{ path: "motion.mp4", logicalName: "motion", type: "video", requirementRefs: [R_MOTION] }],
      proposedFacts: [],
      ...base
    };
  }

  if (request.workItemId.startsWith("integrate-")) {
    writeFileSync(join(workspace, "final-bundle.md"), "bundle missing media manifest", "utf8");
    return {
      status: "completed",
      summary: "first integration intentionally omits media manifest",
      outputs: [{ path: "final-bundle.md", logicalName: "final-bundle", type: "document", requirementRefs: [R_BUNDLE] }],
      proposedFacts: [],
      ...base
    };
  }

  throw new Error(`Unexpected worker ${request.workItemId}: ${objective}`);
}

function reviewResponse(request: AgentCreateRequest) {
  const context = request.context as any;
  if (context?.kind !== "verification-review") return workerEnvelope(request);
  const artifact = context.artifact;
  if (artifact.logicalName === "deck") {
    assert.ok((context.inspectionArtifacts ?? []).length > 0, "deck review must use a derived slide render");
    if (artifact.version === 1) return { status: "fail", detail: "Slide 7 headline overflows the safe canvas and collides with body copy", confidence: 1 };
    return { status: "pass", detail: "Rendered slide geometry is readable with no overflow", confidence: 1 };
  }
  if (artifact.logicalName === "speaker-notes") {
    return { status: "pass", detail: "Speaker notes form a coherent 45-minute technical narrative", confidence: 1 };
  }
  return { status: "pass", detail: "Artifact satisfies the requested review", confidence: 1 };
}

function acquisitionService(root: string, badRepo: string, goodRepo: string) {
  return new SecureAcquisitionService({
    providers: [{
      id: "fixture-motion-discovery",
      async discover() {
        return [
          { id: "candidate-bad-motion", sourceType: "github" as const, sourceUri: badRepo, name: "motion animation rendering video specialist", description: "motion animation rendering video capability", candidateKind: "skill" as const, status: "discovered" as const },
          { id: "candidate-good-motion", sourceType: "github" as const, sourceUri: goodRepo, name: "motion skill", description: "render video", candidateKind: "skill" as const, status: "discovered" as const }
        ];
      }
    }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))),
    overlay: new MissionCapabilityOverlay(),
    activationRoot: join(root, "capabilities"),
    maxCandidates: 3
  });
}

async function setAttemptBudget(runtime: MissionRuntime, missionId: string, revision: number, limit: number) {
  await runtime.configureBudget({ missionId, revision, limits: [{ metric: "attempts", limit, enforcement: "hard", warningAt: Math.max(0, limit - 1) }] });
}

function attemptCount(events: any[]) { return events.filter(event => event.type === "attempt.created").length; }

async function latestFinal(runtime: MissionRuntime, missionId: string, logicalName: string) {
  return (await runtime.projections.listArtifacts(missionId))
    .filter(artifact => artifact.logicalName === logicalName && artifact.status === "final")
    .sort((a, b) => b.version - a.version)[0];
}

test("reference keynote mission survives acquisition fallback, QA repair, steering, stale evidence, integration failure and runtime restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-reference-faults-"));
  const runtimeRoot = join(root, "runtime");
  const badRepo = gitRepo(root, "bad-motion", { "README.md": "motion animation rendering video capability with no executable or skill entrypoint" });
  const goodRepo = gitRepo(root, "good-motion", { "SKILL.md": "# Motion Skill\nSafe instruction-only keynote motion rendering skill.\n" });
  const acquisition = acquisitionService(root, badRepo, goodRepo);
  const provider = referenceProvider();
  const host = new FakeHostAdapter([], { agentResponder: reviewResponse });
  const inspection = new KeynoteRenderInspectionProvider();
  const missionId = "reference-keynote-faults";

  let runtime = new MissionRuntime({ rootDir: runtimeRoot, host, deliberation: provider, acquisition, inspectionProviders: [inspection], maxConcurrency: 1 });
  await runtime.controller.createMission(missionId, "Produce a 45-minute high-production AI technology keynote with editable presentation, speaker notes, motion media and source record");
  await setAttemptBudget(runtime, missionId, 1, 3);
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  let events = await runtime.events.list(missionId);
  assert.equal(attemptCount(events), 3, "research, failed deck and deck repair should consume the first three attempts");
  assert.equal((await runtime.controller.state(missionId)).status, "budget_exhausted");
  assert.equal((await runtime.projections.listGaps(missionId)).filter(gap => ["open", "working", "blocked"].includes(gap.status)).length, 0, "assurance failure must not leave a duplicate runtime gap after its quality gap is repaired");
  assert.ok((await latestFinal(runtime, missionId, "deck"))?.version === 2);
  assert.ok((await runtime.projections.listVerificationResults(missionId)).some(result => result.artifactRef === "deck@1" && result.overall === "fail"));

  await setAttemptBudget(runtime, missionId, 2, 4);
  const steering = await runtime.steer(missionId, "Make the deck more technical and feel like a launch keynote, while keeping the research evidence intact");
  assert.ok(steering.impact.invalidatedWorkItemRefs.includes("notes-presteer"));
  assert.ok(steering.impact.invalidatedWorkItemRefs.includes("motion-presteer"));
  assert.ok(steering.impact.invalidatedWorkItemRefs.includes("integrate-presteer"));
  assert.ok(!steering.impact.invalidatedWorkItemRefs.includes("research-source"));
  await runtime.orchestrator!.whenIdle(missionId);

  events = await runtime.events.list(missionId);
  assert.equal(attemptCount(events), 4);
  assert.equal((await runtime.controller.state(missionId)).status, "budget_exhausted");
  assert.ok(await latestFinal(runtime, missionId, "source-record"), "source branch must remain valid across deck-only steering");
  assert.ok((await latestFinal(runtime, missionId, "deck"))?.version === 3);

  const stale = await runtime.knowledge.markSourceStatus(missionId, "source-old", "stale", "benchmark publisher released a newer result");
  assert.ok(stale.artifactRefs.some(ref => ref.startsWith("source-record@")));
  assert.ok(stale.artifactRefs.some(ref => ref === "deck@3"));
  assert.ok(stale.requirementRefs.includes(R_SOURCE));
  assert.ok(stale.requirementRefs.includes(R_DECK));
  assert.equal((await runtime.projections.listGaps(missionId)).find(gap => gap.id === "stale-source:source-old")?.status, "open");

  await setAttemptBudget(runtime, missionId, 3, 5);
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  events = await runtime.events.list(missionId);
  assert.equal(attemptCount(events), 5);
  assert.equal((await runtime.controller.state(missionId)).status, "budget_exhausted");
  const sourcesAfterRefresh = await runtime.projections.listSources(missionId);
  assert.equal(sourcesAfterRefresh.find(source => source.id === "source-old")?.status, "superseded");
  assert.equal(sourcesAfterRefresh.find(source => source.id === "source-new")?.status, "active");
  const oldTruths = (await runtime.projections.listTruths(missionId)).filter(truth => truth.sourceRefs.includes("source-old"));
  assert.ok(oldTruths.length >= 2);
  assert.ok(oldTruths.every(truth => truth.status === "superseded"));
  assert.ok((await runtime.projections.listTruths(missionId)).some(truth => truth.sourceRefs.includes("source-new") && truth.status === "active" && truth.confidence === "verified"));
  assert.ok((await latestFinal(runtime, missionId, "source-record"))?.version === 2);
  assert.ok((await latestFinal(runtime, missionId, "deck"))?.version === 4);

  await setAttemptBudget(runtime, missionId, 4, 9);
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  events = await runtime.events.list(missionId);
  assert.equal(attemptCount(events), 9, "notes, acquisition, motion and failing integration should bring attempts to nine");
  assert.equal((await runtime.controller.state(missionId)).status, "budget_exhausted");
  assert.ok(events.some(event => event.type === "capability.rejected" && (event.payload as any)?.candidate?.id === "candidate-bad-motion"));
  assert.ok(events.some(event => event.type === "capability.activated" && (event.payload as any)?.candidate?.id === "candidate-good-motion"));
  assert.ok((await runtime.projections.listCapabilities(missionId)).some(capability => capability.scope === "mission" && capability.id.includes("need-motion")));
  assert.ok((await runtime.projections.listVerificationResults(missionId)).some(result => result.artifactRef === "final-bundle@1" && result.overall === "fail"));

  const integrationRepair = (await runtime.projections.listWorkItems(missionId)).find(work => work.purpose === "repair" && work.status === "ready" && work.requirementRefs.includes(R_BUNDLE));
  assert.ok(integrationRepair, "failed integration must produce a ready repair work item before the budget fence stops dispatch");
  assert.equal((await runtime.projections.listGaps(missionId)).filter(gap => ["open", "working", "blocked"].includes(gap.status) && gap.requirementRefs.includes(R_BUNDLE)).length, 1, "integration assurance failure should create one canonical blocking gap");

  await setAttemptBudget(runtime, missionId, 5, 10);
  const recoveryAttemptId = "attempt-integration-recovery";
  const recoveryExecutionId = "execution-integration-recovery";
  const recoveryWorkspace = runtime.workspaces.allocate(missionId, recoveryAttemptId);
  writeFileSync(join(recoveryWorkspace.root, "media-manifest.json"), JSON.stringify({ motion: "motion.mp4", deck: "deck.pptx" }), "utf8");
  writeFileSync(join(recoveryWorkspace.root, "final-bundle.md"), "Integrated keynote bundle after crash", "utf8");
  writeFileSync(join(recoveryWorkspace.root, WORKER_RECOVERY_FILE), JSON.stringify({
    status: "completed",
    summary: "integration finished before runtime crash",
    outputs: [
      { path: "media-manifest.json", logicalName: "media-manifest", type: "document", requirementRefs: [] },
      { path: "final-bundle.md", logicalName: "final-bundle", type: "document", requirementRefs: [R_BUNDLE] }
    ],
    proposedFacts: [],
    proposedWork: [],
    warnings: []
  }), "utf8");

  await runtime.controller.emit(missionId, "attempt.created", { id: recoveryAttemptId, workItemId: integrationRepair!.id, executorId: "host_agent", contextPacketId: "recovery-fault-injection" }, { type: "controller" }, `attempt:${recoveryAttemptId}`);
  await runtime.controller.emit(missionId, "work.started", { id: integrationRepair!.id }, { type: "controller" }, `work-started:${integrationRepair!.id}:${recoveryAttemptId}`);
  await runtime.controller.emit(missionId, "execution.created", { id: recoveryExecutionId, workItemId: integrationRepair!.id, attemptId: recoveryAttemptId, executorType: "host_agent" }, { type: "controller" }, `execution-created:${recoveryExecutionId}`);
  await runtime.controller.emit(missionId, "execution.route.selected", { executionId: recoveryExecutionId, workItemId: integrationRepair!.id, attemptId: recoveryAttemptId, route: "host_agent", reason: "fault injection: crash after durable worker output", capabilityRefs: [] }, { type: "controller" }, `execution-route:${recoveryExecutionId}`);
  await runtime.controller.emit(missionId, "execution.started", { id: recoveryExecutionId, executorType: "host_agent" }, { type: "host" }, `execution-started:${recoveryExecutionId}`);
  assert.equal(attemptCount(await runtime.events.list(missionId)), 10);
  runtime.close();

  runtime = new MissionRuntime({ rootDir: runtimeRoot, host, deliberation: provider, acquisition, inspectionProviders: [inspection], maxConcurrency: 1 });
  const recovery = await runtime.recoverMission(missionId);
  assert.deepEqual(recovery.recovered, [recoveryExecutionId]);
  assert.deepEqual(recovery.lost, []);
  await runtime.orchestrator!.runUntilQuiescent(missionId);

  const finalState = await runtime.controller.state(missionId);
  assert.equal(finalState.status, "completed");
  assert.deepEqual(finalState.blockingGapIds, []);
  const finalArtifacts = (await runtime.projections.listArtifacts(missionId)).filter(artifact => artifact.status === "final").map(artifact => artifact.logicalName);
  for (const required of ["source-record", "deck", "speaker-notes", "motion", "final-bundle"]) assert.ok(finalArtifacts.includes(required), `missing final artifact ${required}`);
  assert.ok((await runtime.projections.listArtifacts(missionId)).some(artifact => artifact.logicalName === "media-manifest" && ["verified", "final"].includes(artifact.status)));
  assert.ok((await runtime.projections.listVerificationResults(missionId)).some(result => result.artifactRef === "final-bundle@2" && result.overall === "pass"));

  const finalEvents = await runtime.events.list(missionId);
  assert.ok(finalEvents.some(event => event.type === "user.steering.received"));
  assert.ok(finalEvents.some(event => event.type === "execution.invocation.recorded" && (event.payload as any)?.recovered === true));
  assert.ok(finalEvents.some(event => event.type === "mission.completed"));
  const receipts = await runtime.projections.listInvocationReceipts(missionId);
  assert.ok(receipts.some(receipt => receipt.executionId === recoveryExecutionId && receipt.result === "succeeded"));
  assert.ok((await runtime.projections.listCostEvents(missionId)).length > 0);
  assert.ok((await runtime.projections.listCapabilityTrustProfiles(missionId)).some(profile => profile.capabilityId.includes("need-motion") && profile.succeeded > 0));
  const completion = await runtime.projections.listCompletionRecords(missionId);
  assert.equal(completion.length, 1);
  assert.deepEqual(completion[0]!.blockingGapRefs, []);
  assert.ok((await runtime.projections.listAuditRecords(missionId)).some(record => record.action === "capability.activated"));
  assert.ok((await runtime.projections.listAuditRecords(missionId)).some(record => record.action === "mission.completed"));
  runtime.close();
});
