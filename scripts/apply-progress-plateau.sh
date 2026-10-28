#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,1))

rep('src/core/domain/event.ts',
'''  | "decision.applied"\n  | "capability.need.created"''',
'''  | "decision.applied"\n  | "progress.observed"\n  | "capability.need.created"''')

rep('src/core/planning/deliberation-provider.ts',
'''import type { SteeringInterpretation } from "../domain/steering.ts";''',
'''import type { SteeringInterpretation } from "../domain/steering.ts";\nimport type { PlateauContext } from "../domain/progress.ts";''')
rep('src/core/planning/deliberation-provider.ts',
'''  relatedWorkItems?: WorkItem[];\n  priorRepairCount?: number;\n}''',
'''  relatedWorkItems?: WorkItem[];\n  priorRepairCount?: number;\n  plateauContext?: PlateauContext;\n}''')

# Host diagnosis sees no-progress history, but remains evidence-constrained by RepairScopePolicy.
rep('src/core/planning/host-deliberation-provider.ts',
'''Prior repair attempts: ${input.priorRepairCount ?? 0}\nChoose the minimum sufficient intervention scope.''',
'''Prior repair attempts: ${input.priorRepairCount ?? 0}\nProgress / plateau context: ${JSON.stringify(input.plateauContext ?? null)}\nIf progress has stalled, consider a broader intervention than the already-attempted scopes, but only when the supplied findings/evidence support that root cause.\nChoose the minimum sufficient intervention scope.''')

# Controller owns progress observation and truthful plateau transition.
rep('src/core/mission/controller.ts',
'''import { SteeringImpactAnalyzer } from "../steering/steering-impact-analyzer.ts";''',
'''import { SteeringImpactAnalyzer } from "../steering/steering-impact-analyzer.ts";\nimport { MissionProgressTracker } from "../progress/progress-tracker.ts";''')
rep('src/core/mission/controller.ts',
'''  private readonly steeringImpact = new SteeringImpactAnalyzer();''',
'''  private readonly steeringImpact = new SteeringImpactAnalyzer();\n  private readonly progressTracker: MissionProgressTracker;''')
rep('src/core/mission/controller.ts',
'''    this.readModel = new MissionReadModel(store, dependencies.projections);\n  }''',
'''    this.readModel = new MissionReadModel(store, dependencies.projections);\n    this.progressTracker = new MissionProgressTracker(store, this.readModel);\n  }''')
rep('src/core/mission/controller.ts',
'''    const openGaps = await this.readModel.openGaps(input.missionId);\n    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));\n    if (this.deliberation && blockingGap) {''',
'''    const openGaps = await this.readModel.openGaps(input.missionId);\n    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));\n    let plateauAssessment: import("../domain/progress.ts").PlateauAssessment | undefined;\n    if (blockingGap) {\n      const snapshot = await this.progressTracker.snapshot(input.missionId, state);\n      plateauAssessment = await this.progressTracker.assess(input.missionId, state, snapshot);\n      await this.emit(input.missionId, "progress.observed", { snapshot, assessment: plateauAssessment }, { type: "controller" }, `progress:${input.missionId}:${state.revision}`);\n      state = await this.state(input.missionId);\n      if (plateauAssessment.state === "plateau") {\n        const decision: MissionDecision = {\n          id: randomUUID(), missionId: input.missionId, type: "block", targetRefs: [blockingGap.id],\n          rationale: plateauAssessment.reason, evidenceRefs: [], gapRefs: [blockingGap.id], requirementRefs: [...blockingGap.requirementRefs],\n          expectedImpact: "Stop unproductive repair churn and report truthful plateau", confidence: 1, requiresApproval: false, status: "applied", createdAt: new Date().toISOString()\n        };\n        await this.emit(input.missionId, "decision.created", { decision }, { type: "controller" }, `plateau-decision:${blockingGap.id}:${state.revision}`);\n        await this.emit(input.missionId, "mission.status.changed", { status: "plateau", reason: plateauAssessment.reason, gapId: blockingGap.id }, { type: "controller" }, `mission-plateau:${blockingGap.id}:${state.revision}`);\n        const plateauState = await this.state(input.missionId);\n        return { missionRevision: plateauState.revision, decisionsCreated: [decision.id], workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: plateauState.status };\n      }\n    }\n    if (this.deliberation && blockingGap) {''')
rep('src/core/mission/controller.ts',
'''          relatedWorkItems,\n          priorRepairCount\n        }));''',
'''          relatedWorkItems,\n          priorRepairCount,\n          plateauContext: plateauAssessment?.context\n        }));''')
PY

cat > tests/integration/progress-plateau.test.ts <<'TS'
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionReadModel } from "../../src/core/mission/mission-read-model.ts";
import { MissionProgressTracker } from "../../src/core/progress/progress-tracker.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup(deliberation?: DeliberationProvider) {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections, deliberation });
  return { db, projections, events, controller, tracker: new MissionProgressTracker(events, new MissionReadModel(events, projections)) };
}

function repair(missionId: string, id: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId, purpose: "repair", objective: "repair persistent gap", status: "failed", requirementRefs: ["r1"], gapRefs: ["g1"], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1, createdBy: "replanner", createdAt: now, updatedAt: now };
}

test("progress tracker suspends plateau while legitimate ready work exists", async () => {
  const { db, controller, tracker } = setup();
  await controller.createMission("m-waiting", "deliver artifact");
  await controller.openGap("m-waiting", { id: "g1", severity: "major", description: "broken" });
  const now = new Date().toISOString();
  await controller.proposeWork({ ...repair("m-waiting", "repair-g1"), status: "ready", createdAt: now, updatedAt: now });
  const state = await controller.state("m-waiting");
  const snapshot = await tracker.snapshot("m-waiting", state);
  const assessment = await tracker.assess("m-waiting", state, snapshot);
  assert.equal(assessment.state, "waiting");
  assert.equal(assessment.context.waitingReason, "ready-work");
  db.close();
});

test("controller reports plateau only after sustained no-progress and a strategy repair has already failed", async () => {
  let lastPlateauContext: any;
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "stuck", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap(input) { lastPlateauContext = input.plateauContext; return { gapId: input.gap.id, rootCause: "persistent system mismatch", intervention: "revise_strategy", repairScope: "strategy", confidence: 0.95, evidenceRefs: ["ev1", "ev2"] }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  const { db, controller, events, tracker } = setup(deliberation);
  await controller.createMission("m-plateau", "deliver artifact");
  await controller.recordEvidence("m-plateau", { id: "ev1", missionId: "m-plateau", subjectRef: "g1", type: "test-result", claim: "repair failed", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.recordEvidence("m-plateau", { id: "ev2", missionId: "m-plateau", subjectRef: "g1", type: "runtime-check", claim: "strategy repair failed", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.openGap("m-plateau", { id: "g1", severity: "major", description: "persistent blocker", evidenceRefs: ["ev1", "ev2"] } as any);
  for (let i = 1; i <= 4; i++) await controller.proposeWork(repair("m-plateau", `repair-g1-${i}`));
  await controller.emit("m-plateau", "decision.created", { decision: { id: "d-strategy", missionId: "m-plateau", type: "revise_strategy", targetRefs: ["g1"], rationale: "strategy repair", evidenceRefs: ["ev1", "ev2"], gapRefs: ["g1"], requirementRefs: [], confidence: 0.95, requiresApproval: false, status: "applied", createdAt: new Date().toISOString() } }, { type: "controller" });
  const state = await controller.state("m-plateau");
  const snapshot = await tracker.snapshot("m-plateau", state);
  for (let i = 0; i < 4; i++) await controller.emit("m-plateau", "progress.observed", { snapshot: { ...snapshot, observedAt: new Date(Date.now() + i).toISOString() } }, { type: "controller" });
  const cycle = await controller.runControllerCycle({ missionId: "m-plateau", trigger: "verification_event" });
  assert.equal(cycle.status, "plateau");
  const after = await controller.state("m-plateau");
  assert.equal(after.status, "plateau");
  assert.ok((await events.list("m-plateau")).some(event => event.type === "mission.status.changed" && (event.payload as any).status === "plateau"));
  assert.equal(lastPlateauContext, undefined, "once plateau is established no new diagnosis/repair should be dispatched");
  db.close();
});

test("stalled progress is passed into diagnosis before plateau so repair can escalate with evidence", async () => {
  let captured: any;
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "stalled", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap(input) { captured = input.plateauContext; return { gapId: input.gap.id, rootCause: "executor mismatch", intervention: "replace_executor", repairScope: "executor", confidence: 0.9, evidenceRefs: ["ev1"] }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  const { db, controller, tracker } = setup(deliberation);
  await controller.createMission("m-stalled", "deliver artifact");
  await controller.recordEvidence("m-stalled", { id: "ev1", missionId: "m-stalled", subjectRef: "g1", type: "test-result", claim: "same executor repeatedly fails", result: "contradicts", createdAt: new Date().toISOString() });
  await controller.openGap("m-stalled", { id: "g1", severity: "major", description: "persistent blocker", findingRefs: [], requirementRefs: [], artifactRefs: [] });
  const state = await controller.state("m-stalled");
  const snapshot = await tracker.snapshot("m-stalled", state);
  await controller.emit("m-stalled", "progress.observed", { snapshot }, { type: "controller" });
  await controller.emit("m-stalled", "progress.observed", { snapshot: { ...snapshot, observedAt: new Date().toISOString() } }, { type: "controller" });
  const cycle = await controller.runControllerCycle({ missionId: "m-stalled", trigger: "verification_event" });
  assert.ok(captured);
  assert.ok(captured.stagnationCount >= 3);
  assert.equal(cycle.status, "active");
  db.close();
});
TS
