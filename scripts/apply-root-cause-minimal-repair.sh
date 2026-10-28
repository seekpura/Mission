#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path
import re


def read(path: str) -> str:
    return Path(path).read_text()


def write(path: str, content: str) -> None:
    Path(path).write_text(content)


def replace_once(path: str, old: str, new: str) -> None:
    text = read(path)
    if old not in text:
        raise SystemExit(f"missing replacement anchor in {path}: {old[:120]!r}")
    write(path, text.replace(old, new, 1))


def sub_once(path: str, pattern: str, repl: str) -> None:
    text = read(path)
    updated, count = re.subn(pattern, repl, text, count=1, flags=re.S)
    if count != 1:
        raise SystemExit(f"expected one regex replacement in {path}, got {count}")
    write(path, updated)

write("src/core/planning/deliberation-provider.ts", '''import type { AcceptanceContract, MissionSpec, MissionState } from "../domain/mission.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Evidence, Finding, Gap } from "../domain/verification.ts";

export interface MissionInterpretation {
  missionSpec: MissionSpec;
  acceptanceContract: AcceptanceContract;
}

export interface StrategyProposal {
  framing: string;
  approach: string;
  workstreams: Array<{ id: string; objective: string }>;
  revision: number;
}

export interface FrontierProposal {
  workItems: WorkItem[];
  capabilityNeeds?: CapabilityNeed[];
  graphRevision: number;
}

export type RepairScope = "attempt" | "work_item" | "executor" | "capability" | "graph" | "strategy";

export interface RootCauseHypothesis {
  statement: string;
  confidence: number;
  findingRefs: string[];
  evidenceRefs: string[];
}

export interface GapDiagnosis {
  gapId: string;
  rootCause: string;
  intervention: "retry" | "revise_work" | "replace_executor" | "replace_capability" | "replan_local" | "revise_strategy";
  confidence: number;
  repairScope?: RepairScope;
  hypotheses?: RootCauseHypothesis[];
  evidenceRefs?: string[];
  rootCauseKeyCandidate?: string;
}

export interface CompletionChallenge {
  blockingObjection: boolean;
  objections: Array<{ description: string; requirementRefs: string[]; artifactRefs: string[]; severity: "blocking" | "non_blocking" }>;
  confidence: number;
}

export interface DeliberationProvider {
  interpretMission?(input: { missionId: string; userGoal: string; state: MissionState }): Promise<MissionInterpretation>;
  composeStrategy(input: { state: MissionState; userGoal: string; acceptanceContract?: AcceptanceContract | null }): Promise<StrategyProposal>;
  planFrontier(input: { state: MissionState; userGoal: string; openGaps: Gap[]; acceptanceContract?: AcceptanceContract | null; requirements?: import("../domain/mission.ts").Requirement[] }): Promise<FrontierProposal>;
  diagnoseGap(input: {
    state: MissionState;
    gap: Gap;
    findings?: Finding[];
    evidence?: Evidence[];
    relatedWorkItems?: WorkItem[];
    priorRepairCount?: number;
  }): Promise<GapDiagnosis>;
  challengeCompletion(input: { state: MissionState }): Promise<CompletionChallenge>;
}
''')

write("src/core/planning/deterministic-deliberation.ts", '''import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge, MissionInterpretation } from "./deliberation-provider.ts";

export class DeterministicDeliberationProvider implements DeliberationProvider {
  async interpretMission(input: { missionId: string; userGoal: string }): Promise<MissionInterpretation> {
    const now = new Date().toISOString();
    return {
      missionSpec: {
        missionId: input.missionId,
        revision: 1,
        objective: input.userGoal,
        requestedOutputs: [],
        constraints: [],
        preferences: [],
        sourceRefs: [],
        createdAt: now
      },
      acceptanceContract: {
        missionId: input.missionId,
        revision: 1,
        requirements: [],
        requiredArtifacts: [],
        requiredValidations: [],
        criticalFailureConditions: [],
        createdAt: now
      }
    };
  }
  async composeStrategy(input: any): Promise<StrategyProposal> {
    return { framing: input.userGoal, approach: "progressive", workstreams: [], revision: 1 };
  }
  async planFrontier(input: any): Promise<FrontierProposal> {
    return { workItems: [], capabilityNeeds: [], graphRevision: input.state.graphRevision + 1 };
  }
  async diagnoseGap(input: any): Promise<GapDiagnosis> {
    const findings = Array.isArray(input.findings) ? input.findings : [];
    const evidenceRefs = [...new Set(findings.flatMap((finding: any) => finding.evidenceRefs ?? []))];
    return {
      gapId: input.gap.id,
      rootCause: input.gap.description,
      intervention: "revise_work",
      repairScope: "work_item",
      confidence: 0.8,
      evidenceRefs,
      hypotheses: [{
        statement: input.gap.description,
        confidence: 0.8,
        findingRefs: findings.map((finding: any) => finding.id),
        evidenceRefs
      }]
    };
  }
  async challengeCompletion(): Promise<CompletionChallenge> {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}
''')

write("src/core/planning/repair-scope-policy.ts", '''import type { GapDiagnosis, RepairScope } from "./deliberation-provider.ts";

export interface RepairScopeContext {
  findingRefs?: string[];
  evidenceRefs?: string[];
  priorRepairCount?: number;
}

export function normalizeGapDiagnosis(diagnosis: GapDiagnosis, context: RepairScopeContext = {}): GapDiagnosis {
  const hypotheses = diagnosis.hypotheses ?? [];
  const evidenceRefs = unique([...(diagnosis.evidenceRefs ?? []), ...(context.evidenceRefs ?? []), ...hypotheses.flatMap(item => item.evidenceRefs)]);
  const supportRefs = unique([...(context.findingRefs ?? []), ...evidenceRefs, ...hypotheses.flatMap(item => item.findingRefs)]);
  const requested = diagnosis.repairScope ?? scopeForIntervention(diagnosis.intervention);
  let repairScope = constrainScope(requested, diagnosis.confidence, supportRefs.length);
  if ((context.priorRepairCount ?? 0) > 0 && repairScope === "attempt") repairScope = "work_item";
  return {
    ...diagnosis,
    hypotheses,
    evidenceRefs,
    repairScope,
    intervention: interventionForScope(repairScope)
  };
}

export function interventionForScope(scope: RepairScope): GapDiagnosis["intervention"] {
  if (scope === "attempt") return "retry";
  if (scope === "work_item") return "revise_work";
  if (scope === "executor") return "replace_executor";
  if (scope === "capability") return "replace_capability";
  if (scope === "graph") return "replan_local";
  return "revise_strategy";
}

export function scopeForIntervention(intervention: GapDiagnosis["intervention"]): RepairScope {
  if (intervention === "retry") return "attempt";
  if (intervention === "revise_work") return "work_item";
  if (intervention === "replace_executor") return "executor";
  if (intervention === "replace_capability") return "capability";
  if (intervention === "replan_local") return "graph";
  return "strategy";
}

function constrainScope(scope: RepairScope, confidence: number, supportCount: number): RepairScope {
  if (scope === "strategy") {
    if (confidence >= 0.85 && supportCount >= 2) return "strategy";
    if (confidence >= 0.75 && supportCount >= 2) return "graph";
    return "work_item";
  }
  if (scope === "graph") return confidence >= 0.75 && supportCount >= 2 ? "graph" : "work_item";
  if (scope === "capability" || scope === "executor") return confidence >= 0.65 && supportCount >= 1 ? scope : "work_item";
  if (scope === "work_item") return confidence >= 0.4 ? "work_item" : "attempt";
  return "attempt";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
''')

replace_once(
    "src/core/domain/decision.ts",
    '  | "replace_capability"\n',
    '  | "replace_executor"\n  | "replace_capability"\n'
)

replace_once(
    "src/core/mission/mission-read-model.ts",
    'import type { Evidence, Gap, VerificationResult } from "../domain/verification.ts";',
    'import type { Evidence, Finding, Gap, VerificationResult } from "../domain/verification.ts";'
)
replace_once(
    "src/core/mission/mission-read-model.ts",
    '  async acceptanceContract(missionId: string): Promise<AcceptanceContract | null> {',
    '''  async findings(missionId: string): Promise<Finding[]> {
    if (this.projections) return this.projections.listFindings(missionId);
    return (await this.store.list(missionId))
      .filter(event => event.type === "finding.created")
      .map(event => (((event.payload as any).finding ?? event.payload) as Finding));
  }

  async acceptanceContract(missionId: string): Promise<AcceptanceContract | null> {'''
)

sub_once(
    "src/core/planning/host-deliberation-provider.ts",
    r'  async diagnoseGap\(input: Parameters<DeliberationProvider\["diagnoseGap"\]>\[0\]\): Promise<GapDiagnosis> \{.*?\n  async challengeCompletion',
    '''  async diagnoseGap(input: Parameters<DeliberationProvider["diagnoseGap"]>[0]): Promise<GapDiagnosis> {
    const value = await this.askJson(input.state.missionId, `gap-${input.gap.id}`, `
You are the Mission Runtime Gap Diagnostician.
State: ${JSON.stringify(input.state)}
Gap: ${JSON.stringify(input.gap)}
Findings: ${JSON.stringify(input.findings ?? [])}
Evidence: ${JSON.stringify(input.evidence ?? [])}
Related work items: ${JSON.stringify(input.relatedWorkItems ?? [])}
Prior repair count: ${input.priorRepairCount ?? 0}
Generate competing root-cause hypotheses before choosing a repair scope. Prefer the minimum sufficient repair. A repeated semantic failure must not be treated as the same transient attempt retry. Do not claim a root cause unsupported by the supplied findings/evidence.
Return ONLY JSON: {"gapId":string,"rootCause":string,"hypotheses":[{"statement":string,"confidence":number,"findingRefs":string[],"evidenceRefs":string[]}],"repairScope":"attempt|work_item|executor|capability|graph|strategy","intervention":"retry|revise_work|replace_executor|replace_capability|replan_local|revise_strategy","confidence":number,"evidenceRefs":string[],"rootCauseKeyCandidate":string|null}.
`);
    const allowedInterventions = ["retry", "revise_work", "replace_executor", "replace_capability", "replan_local", "revise_strategy"];
    const intervention = allowedInterventions.includes(value.intervention)
      ? value.intervention as GapDiagnosis["intervention"] : "revise_work";
    const allowedScopes = ["attempt", "work_item", "executor", "capability", "graph", "strategy"];
    const repairScope = allowedScopes.includes(value.repairScope) ? value.repairScope as NonNullable<GapDiagnosis["repairScope"]> : undefined;
    const hypotheses = arrayValue(value.hypotheses).slice(0, 5).map((raw: any) => ({
      statement: stringValue(raw?.statement, stringValue(value.rootCause, input.gap.description)),
      confidence: clamp01(numberValue(raw?.confidence, 0.5)),
      findingRefs: stringArray(raw?.findingRefs),
      evidenceRefs: stringArray(raw?.evidenceRefs)
    }));
    return {
      gapId: input.gap.id,
      rootCause: stringValue(value.rootCause, input.gap.description),
      intervention,
      repairScope,
      confidence: clamp01(numberValue(value.confidence, 0.7)),
      evidenceRefs: stringArray(value.evidenceRefs),
      hypotheses,
      rootCauseKeyCandidate: typeof value.rootCauseKeyCandidate === "string" && value.rootCauseKeyCandidate.trim() ? value.rootCauseKeyCandidate.trim() : undefined
    };
  }

  async challengeCompletion'''
)

replace_once(
    "src/core/mission/controller.ts",
    'import type { DeliberationProvider, CompletionChallenge } from "../planning/deliberation-provider.ts";',
    'import type { DeliberationProvider, CompletionChallenge, GapDiagnosis } from "../planning/deliberation-provider.ts";\nimport { normalizeGapDiagnosis } from "../planning/repair-scope-policy.ts";'
)

sub_once(
    "src/core/mission/controller.ts",
    r'    const openGaps = await this\.readModel\.openGaps\(input\.missionId\);\n    const blockingGap = openGaps\.find\(gap => gap\.status === "open" && \(gap\.severity === "critical" \|\| gap\.severity === "major"\)\);\n    if \(this\.deliberation && blockingGap\) \{.*?\n    \}\n\n    if \(this\.deliberation && this\.shouldPlanFrontier\(state\)\) \{',
    '''    const openGaps = await this.readModel.openGaps(input.missionId);
    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));
    if (this.deliberation && blockingGap) {
      const allWorkItems = await this.readModel.workItems(input.missionId);
      const relatedWorkItems = allWorkItems.filter(work => work.gapRefs.includes(blockingGap.id));
      const existingRepair = relatedWorkItems.find(work =>
        !["succeeded", "invalidated", "superseded", "abandoned"].includes(work.status)
      );
      if (!existingRepair) {
        const findingIds = new Set(blockingGap.findingRefs);
        const findings = (await this.readModel.findings(input.missionId)).filter(finding => findingIds.has(finding.id));
        const evidenceIds = new Set(findings.flatMap(finding => finding.evidenceRefs));
        const evidence = (await this.readModel.evidence(input.missionId)).filter(item => evidenceIds.has(item.id));
        const priorRepairCount = relatedWorkItems.filter(work => work.purpose === "repair").length;
        const rawDiagnosis = await this.deliberation.diagnoseGap({
          state,
          gap: blockingGap,
          findings,
          evidence,
          relatedWorkItems,
          priorRepairCount
        });
        const diagnosis = normalizeGapDiagnosis(rawDiagnosis, {
          findingRefs: findings.map(finding => finding.id),
          evidenceRefs: evidence.map(item => item.id),
          priorRepairCount
        });
        const decision = this.decisionForDiagnosis(input.missionId, blockingGap, diagnosis);
        await this.emit(input.missionId, "decision.created", { decision, diagnosis }, { type: "controller" }, `decision:${blockingGap.id}:${diagnosis.intervention}:${priorRepairCount + 1}`);
        decisionsCreated.push(decision.id);

        if (diagnosis.intervention === "replan_local" || diagnosis.intervention === "revise_strategy") {
          if (diagnosis.intervention === "revise_strategy") {
            const proposal = await this.deliberation.composeStrategy({
              state,
              userGoal: await this.readModel.userGoal(input.missionId),
              acceptanceContract: await this.readModel.acceptanceContract(input.missionId)
            });
            const revision = Math.max((state.strategyRevision ?? 0) + 1, proposal.revision);
            await this.emit(input.missionId, "strategy.revised", { ...proposal, revision }, { type: "planner" }, `strategy:${input.missionId}:${revision}`);
            state = await this.state(input.missionId);
          }
          const frontier = await this.deliberation.planFrontier({
            state,
            userGoal: await this.readModel.userGoal(input.missionId),
            openGaps,
            acceptanceContract: await this.readModel.acceptanceContract(input.missionId),
            requirements: await this.readModel.requirements(input.missionId)
          });
          if (frontier.graphRevision > state.graphRevision) {
            await this.emit(input.missionId, "graph.revised", { revision: frontier.graphRevision }, { type: "planner" }, `graph:${input.missionId}:${frontier.graphRevision}`);
          }
          for (const need of frontier.capabilityNeeds ?? []) {
            await this.emit(input.missionId, "capability.need.created", { need }, { type: "planner" }, `capability-need:${need.id}`);
          }
          for (const work of frontier.workItems) {
            await this.proposeWork(work);
            workItemsCreated.push(work.id);
          }
        } else {
          const repair = this.repairWorkItem(state, blockingGap, diagnosis, priorRepairCount + 1);
          await this.proposeWork(repair);
          workItemsCreated.push(repair.id);
        }
        state = await this.state(input.missionId);
      }
    }

    if (this.deliberation && this.shouldPlanFrontier(state)) {'''
)

sub_once(
    "src/core/mission/controller.ts",
    r'  private decisionForDiagnosis\(missionId: string, gap: Gap, diagnosis: \{.*?\n  private async materializeCompletionObjections',
    '''  private decisionForDiagnosis(missionId: string, gap: Gap, diagnosis: GapDiagnosis): MissionDecision {
    const type: MissionDecision["type"] = diagnosis.intervention === "replace_executor" ? "replace_executor"
      : diagnosis.intervention === "replace_capability" ? "replace_capability"
      : diagnosis.intervention === "replan_local" ? "replan_local"
      : diagnosis.intervention === "revise_strategy" ? "revise_strategy"
      : diagnosis.intervention === "retry" ? "retry"
      : "revise_work";
    return {
      id: randomUUID(),
      missionId,
      type,
      targetRefs: [gap.id],
      rationale: `${diagnosis.rootCause} [repair_scope=${diagnosis.repairScope ?? "work_item"}]`,
      evidenceRefs: [...(diagnosis.evidenceRefs ?? [])],
      gapRefs: [gap.id],
      requirementRefs: [...gap.requirementRefs],
      expectedImpact: `Resolve ${gap.severity} gap ${gap.id} with the minimum sufficient repair scope`,
      confidence: diagnosis.confidence,
      requiresApproval: false,
      status: "proposed",
      createdAt: new Date().toISOString()
    };
  }

  private repairWorkItem(state: MissionState, gap: Gap, diagnosis: GapDiagnosis, sequence: number): WorkItem {
    const now = new Date().toISOString();
    const id = sequence <= 1 ? `repair-${gap.id}` : `repair-${gap.id}-${sequence}`;
    return {
      id,
      missionId: state.missionId,
      purpose: "repair",
      objective: `Resolve gap: ${gap.description}. Diagnosed cause: ${diagnosis.rootCause}. Repair scope: ${diagnosis.repairScope ?? "work_item"}`,
      status: "ready",
      requirementRefs: [...gap.requirementRefs],
      gapRefs: [gap.id],
      inputArtifactRefs: [...gap.artifactRefs],
      expectedOutputs: [],
      localAcceptanceCriteria: [{ id: `resolve-${gap.id}`, description: `Gap ${gap.id} is resolved and independently verified`, priority: "required" }],
      capabilityNeedRefs: [],
      priority: gap.severity === "critical" ? 100 : gap.severity === "major" ? 80 : 50,
      graphRevision: state.graphRevision,
      createdBy: "replanner",
      createdAt: now,
      updatedAt: now
    };
  }

  private async materializeCompletionObjections'''
)

write("tests/integration/root-cause-repair.test.ts", '''import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";

function setup(deliberation: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  return { db, events, projections, controller: new MissionController(events, { projections, deliberation }) };
}

function baseProvider(overrides: Partial<DeliberationProvider>): DeliberationProvider {
  return {
    async composeStrategy({ state }) {
      return { framing: "repair", approach: "progressive", workstreams: [], revision: (state.strategyRevision ?? 0) + 1 };
    },
    async planFrontier({ state }) {
      return { graphRevision: state.graphRevision + 1, workItems: [], capabilityNeeds: [] };
    },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", repairScope: "work_item", confidence: 0.9 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    },
    ...overrides
  };
}

async function addFindingAndEvidence(controller: MissionController, missionId: string, gapId: string) {
  const now = new Date().toISOString();
  await controller.recordEvidence(missionId, {
    id: "e-root", missionId, subjectRef: "deck@1", type: "render-inspection", claim: "render shows overflow", result: "contradicts", createdAt: now
  });
  await controller.emit(missionId, "finding.created", { finding: {
    id: "f-root", missionId, artifactRef: "deck@1", category: "visual", severity: "major",
    observation: "text overflows the slide", expected: "all text remains in bounds", requirementRefs: [], evidenceRefs: ["e-root"],
    confidence: 0.98, checkId: "visual-overflow", reproducible: true, createdAt: now
  } }, { type: "verifier" }, `finding:${gapId}:f-root`);
  await controller.openGap(missionId, { id: gapId, severity: "major", description: "deck text overflow", artifactRefs: ["deck@1"], findingRefs: ["f-root"] });
}

test("diagnosis receives durable findings/evidence and caps unsupported broad repair", async () => {
  let observed: any;
  const provider = baseProvider({
    async diagnoseGap(input) {
      observed = input;
      return {
        gapId: input.gap.id,
        rootCause: "possible theme geometry mismatch",
        intervention: "revise_strategy",
        repairScope: "strategy",
        confidence: 0.55,
        evidenceRefs: ["e-root"],
        hypotheses: [{ statement: "possible theme geometry mismatch", confidence: 0.55, findingRefs: ["f-root"], evidenceRefs: ["e-root"] }]
      };
    }
  });
  const { db, events, projections, controller } = setup(provider);
  await controller.createMission("m-root-cap", "repair the deck");
  await addFindingAndEvidence(controller, "m-root-cap", "g-root");
  const cycle = await controller.runControllerCycle({ missionId: "m-root-cap", trigger: "verification_event" });
  assert.equal(observed.findings.length, 1);
  assert.equal(observed.findings[0].id, "f-root");
  assert.equal(observed.evidence.length, 1);
  assert.equal(observed.evidence[0].id, "e-root");
  assert.deepEqual(cycle.workItemsCreated, ["repair-g-root"]);
  const decisionEvent = (await events.list("m-root-cap")).find(event => event.type === "decision.created");
  assert.equal((decisionEvent?.payload as any).decision.type, "revise_work");
  assert.equal((decisionEvent?.payload as any).diagnosis.repairScope, "work_item");
  assert.ok((await projections.listWorkItems("m-root-cap")).some(work => work.id === "repair-g-root"));
  db.close();
});

test("a recurring gap creates a new repair attempt and does not repeat transient retry", async () => {
  let calls = 0;
  const provider = baseProvider({
    async diagnoseGap({ gap }) {
      calls += 1;
      return calls === 1
        ? { gapId: gap.id, rootCause: "bad local layout", intervention: "revise_work", repairScope: "work_item", confidence: 0.9 }
        : { gapId: gap.id, rootCause: "retry the same operation", intervention: "retry", repairScope: "attempt", confidence: 0.9 };
    }
  });
  const { db, events, controller } = setup(provider);
  await controller.createMission("m-repeat-repair", "repair until verified");
  await controller.openGap("m-repeat-repair", { id: "g-repeat", severity: "major", description: "artifact still fails" });
  const first = await controller.runControllerCycle({ missionId: "m-repeat-repair", trigger: "verification_event" });
  assert.deepEqual(first.workItemsCreated, ["repair-g-repeat"]);
  await controller.emit("m-repeat-repair", "work.completed", { id: "repair-g-repeat" }, { type: "worker" });
  const second = await controller.runControllerCycle({ missionId: "m-repeat-repair", trigger: "verification_event" });
  assert.deepEqual(second.workItemsCreated, ["repair-g-repeat-2"]);
  const decisions = (await events.list("m-repeat-repair")).filter(event => event.type === "decision.created");
  assert.equal((decisions.at(-1)?.payload as any).decision.type, "revise_work");
  assert.equal((decisions.at(-1)?.payload as any).diagnosis.repairScope, "work_item");
  db.close();
});

test("high-confidence evidence-backed strategy repair revises strategy and replans instead of creating a generic repair", async () => {
  let composeCalls = 0;
  const provider = baseProvider({
    async composeStrategy({ state }) {
      composeCalls += 1;
      return { framing: `repair-${composeCalls}`, approach: "reframe", workstreams: [], revision: (state.strategyRevision ?? 0) + 1 };
    },
    async diagnoseGap({ gap }) {
      return {
        gapId: gap.id,
        rootCause: "the current strategy selected the wrong artifact architecture",
        intervention: "revise_strategy",
        repairScope: "strategy",
        confidence: 0.95,
        evidenceRefs: ["e-root"],
        hypotheses: [{ statement: "the current strategy selected the wrong artifact architecture", confidence: 0.95, findingRefs: ["f-root"], evidenceRefs: ["e-root"] }]
      };
    },
    async planFrontier({ state, openGaps }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        capabilityNeeds: [],
        workItems: [{
          id: "w-strategy-fix", missionId: state.missionId, purpose: "repair", objective: "implement the revised strategy",
          status: "ready", requirementRefs: [], gapRefs: [openGaps[0]!.id], inputArtifactRefs: ["deck@1"], expectedOutputs: [],
          localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: state.graphRevision + 1,
          createdBy: "replanner", createdAt: now, updatedAt: now
        }]
      };
    }
  });
  const { db, projections, controller } = setup(provider);
  await controller.createMission("m-strategy-repair", "repair strategy-level failure");
  await addFindingAndEvidence(controller, "m-strategy-repair", "g-strategy");
  const cycle = await controller.runControllerCycle({ missionId: "m-strategy-repair", trigger: "verification_event" });
  assert.deepEqual(cycle.workItemsCreated, ["w-strategy-fix"]);
  assert.equal((await controller.state("m-strategy-repair")).strategyRevision, 2);
  assert.ok((await projections.listWorkItems("m-strategy-repair")).some(work => work.id === "w-strategy-fix"));
  assert.ok(!(await projections.listWorkItems("m-strategy-repair")).some(work => work.id.startsWith("repair-g-strategy")));
  db.close();
});
''')
PY

npm test
npm run smoke

git diff --check

git add src tests
if ! git diff --cached --quiet; then
  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git commit -m "feat: diagnose root causes and target minimal repair scope"
fi
