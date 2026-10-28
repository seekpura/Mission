import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FindingGapManager } from "../../src/core/verification/finding-gap-manager.ts";
import type { Finding } from "../../src/core/domain/verification.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function finding(id: string, slide: number, observation: string, severity: Finding["severity"] = "major"): Finding {
  return {
    id,
    missionId: "m-cluster",
    artifactRef: "deck@1",
    category: "visual",
    severity,
    location: { slide },
    observation,
    expected: "Text remains within the slide bounds",
    requirementRefs: ["R-VISUAL"],
    evidenceRefs: [],
    confidence: 1,
    checkId: "slide-overflow",
    rootCauseKey: "font-fallback:inter-body",
    reproducible: true,
    createdAt: new Date(Date.now() + slide).toISOString()
  };
}

function deliberation(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: [], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: { missionId, revision: 1, requirements: [], requiredArtifacts: [], requiredValidations: [], criticalFailureConditions: [], createdAt: now }
      };
    },
    async composeStrategy() { return { framing: "repair clustered QA defects", approach: "repair root cause once", workstreams: [{ id: "qa", objective: "resolve QA gaps" }], revision: 1 }; },
    async planFrontier({ state }) { return { graphRevision: state.graphRevision, capabilityNeeds: [], workItems: [] }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: "font fallback changes text geometry across slides", intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("multiple findings with one explicit root cause become one durable canonical gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-gap-cluster-"));
  const runtime = new MissionRuntime({ rootDir: root });
  await runtime.controller.createMission("m-cluster", "fix deck QA issues");
  const manager = new FindingGapManager({ controller: runtime.controller, projections: runtime.projections });

  const first = await manager.record(finding("finding-1", 3, "Slide 3 text overflows the body frame"));
  const second = await manager.record(finding("finding-2", 7, "Slide 7 text overflows the body frame", "critical"));
  assert.equal(first.gap?.id, second.gap?.id);

  let findings = await runtime.projections.listFindings("m-cluster");
  let gaps = await runtime.projections.listGaps("m-cluster");
  assert.equal(findings.length, 2);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.findingRefs.length, 2);
  assert.equal(gaps[0]?.occurrenceCount, 2);
  assert.equal(gaps[0]?.severity, "critical");
  assert.deepEqual(gaps[0]?.artifactRefs, ["deck@1"]);
  assert.equal(gaps[0]?.rootCauseKey, "font-fallback:inter-body");

  const duplicate = await manager.record(finding("finding-2", 7, "Slide 7 text overflows the body frame", "critical"));
  assert.equal(duplicate.action, "duplicate");
  gaps = await runtime.projections.listGaps("m-cluster");
  assert.equal(gaps[0]?.occurrenceCount, 2);

  await runtime.controller.resolveGap("m-cluster", gaps[0]!.id);
  assert.equal((await runtime.projections.listGaps("m-cluster"))[0]?.status, "resolved");

  const regression = await manager.record(finding("finding-3", 12, "Slide 12 text overflows the body frame"));
  assert.equal(regression.action, "reopened_gap");
  gaps = await runtime.projections.listGaps("m-cluster");
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.status, "open");
  assert.equal(gaps[0]?.occurrenceCount, 3);
  assert.ok((await runtime.controller.state("m-cluster")).openGapIds.includes(gaps[0]!.id));

  await runtime.rebuildProjection("m-cluster");
  findings = await runtime.projections.listFindings("m-cluster");
  gaps = await runtime.projections.listGaps("m-cluster");
  assert.equal(findings.length, 3);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.status, "open");
  assert.equal(gaps[0]?.occurrenceCount, 3);
  runtime.close();
});

test("different root causes remain separate and controller creates one repair per canonical blocking gap frontier", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-gap-repair-target-"));
  const runtime = new MissionRuntime({ rootDir: root, deliberation: deliberation() });
  await runtime.controller.createMission("m-cluster", "fix deck QA issues");
  const manager = new FindingGapManager({ controller: runtime.controller, projections: runtime.projections });

  await manager.record(finding("finding-1", 3, "Slide 3 text overflows the body frame"));
  await manager.record(finding("finding-2", 7, "Slide 7 text overflows the body frame"));
  const other = { ...finding("finding-contrast", 9, "Slide 9 contrast is below the required threshold"), rootCauseKey: "contrast:muted-text", checkId: "contrast" };
  await manager.record(other);

  const gaps = await runtime.projections.listGaps("m-cluster");
  assert.equal(gaps.length, 2);
  const overflowGap = gaps.find(gap => gap.rootCauseKey === "font-fallback:inter-body");
  assert.ok(overflowGap);

  await runtime.controller.runControllerCycle({ missionId: "m-cluster", trigger: "verification_event" });
  const work = await runtime.projections.listWorkItems("m-cluster");
  const repairs = work.filter(item => item.purpose === "repair");
  assert.equal(repairs.length, 1, "one controller cycle targets one canonical blocking root gap rather than every symptom finding");
  assert.deepEqual(repairs[0]?.gapRefs, [overflowGap!.id]);
  runtime.close();
});
