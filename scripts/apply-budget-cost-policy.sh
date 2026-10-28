#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,1))

# Mission/Event contracts distinguish budget exhaustion from plateau/failure.
rep('src/core/domain/mission.ts',
'''  | "plateau"\n  | "completed"''',
'''  | "plateau"\n  | "budget_exhausted"\n  | "completed"''')
rep('src/core/domain/event.ts',
'''  | "progress.observed"\n  | "capability.need.created"''',
'''  | "progress.observed"\n  | "budget.configured"\n  | "cost.recorded"\n  | "budget.exhausted"\n  | "capability.need.created"''')

# Execution backends may report authoritative usage. Missing usage is never invented.
rep('src/core/domain/execution.ts',
'''import type { ArtifactExpectation } from "./work-item.ts";''',
'''import type { ArtifactExpectation } from "./work-item.ts";\nimport type { ExecutionUsage } from "./budget.ts";''')
rep('src/core/domain/execution.ts',
'''  executorRef?: string;\n  producedFiles: ProducedFile[];''',
'''  executorRef?: string;\n  usage?: ExecutionUsage;\n  producedFiles: ProducedFile[];''')

# Controller owns durable budget configuration, measured cost events and terminal budget gate.
rep('src/core/mission/controller.ts',
'''import { MissionProgressTracker } from "../progress/progress-tracker.ts";''',
'''import { MissionProgressTracker } from "../progress/progress-tracker.ts";\nimport { BudgetTracker } from "../budget/budget-tracker.ts";\nimport type { BudgetAssessment, CostEvent, MissionBudget } from "../domain/budget.ts";''')
rep('src/core/mission/controller.ts',
'''  private readonly progressTracker: MissionProgressTracker;''',
'''  private readonly progressTracker: MissionProgressTracker;\n  private readonly budgetTracker: BudgetTracker;''')
rep('src/core/mission/controller.ts',
'''    this.progressTracker = new MissionProgressTracker(store, this.readModel);\n  }''',
'''    this.progressTracker = new MissionProgressTracker(store, this.readModel);\n    this.budgetTracker = new BudgetTracker(store, this.readModel);\n  }''')
marker='''  async steer(missionId: string, message: string) {'''
methods='''  async configureBudget(missionId: string, budget: MissionBudget): Promise<BudgetAssessment> {\n    validateBudget(budget);\n    await this.emit(missionId, "budget.configured", { budget }, { type: "user" }, `budget-configured:${missionId}:${budgetFingerprint(budget)}`);\n    const state = await this.state(missionId);\n    const assessment = await this.budgetTracker.assess(missionId, state);\n    if (state.status === "budget_exhausted" && !assessment.exhausted) {\n      await this.emit(missionId, "mission.status.changed", { status: "active", reason: "Budget increased or reset" }, { type: "user" }, `budget-resumed:${state.revision}`);\n    }\n    return this.budgetTracker.assess(missionId, await this.state(missionId));\n  }\n\n  async recordCost(missionId: string, cost: CostEvent): Promise<void> {\n    if (cost.missionId !== missionId) throw new Error("Cost event mission mismatch");\n    validateUsage(cost.usage);\n    await this.emit(missionId, "cost.recorded", { cost }, { type: "system" }, `cost:${cost.id}`);\n  }\n\n  async budgetAssessment(missionId: string): Promise<BudgetAssessment> {\n    return this.budgetTracker.assess(missionId, await this.state(missionId));\n  }\n\n'''
rep('src/core/mission/controller.ts', marker, methods+marker)
rep('src/core/mission/controller.ts',
'''    let state = await this.state(input.missionId);\n\n    if (this.deliberation && state.strategyRevision === null) {''',
'''    let state = await this.state(input.missionId);\n\n    if (state.status !== "completed") {\n      const budget = await this.budgetTracker.assess(input.missionId, state);\n      if (budget.exhausted) {\n        const completion = await this.completeIfEligible(input.missionId);\n        if (completion.status === "completed") {\n          return { missionRevision: completion.revision, decisionsCreated, workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: completion.status };\n        }\n        await this.emit(input.missionId, "budget.exhausted", { assessment: budget }, { type: "controller" }, `budget-exhausted:${budgetFingerprint(budget.budget ?? {})}:${budget.usage.attempts}:${budget.usage.totalTokens}:${budget.usage.capabilityAcquisitions}`);\n        await this.emit(input.missionId, "mission.status.changed", { status: "budget_exhausted", reason: budget.reasons.join("; ") }, { type: "controller" }, `mission-budget-exhausted:${state.revision}`);\n        state = await this.state(input.missionId);\n        return { missionRevision: state.revision, decisionsCreated, workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: state.status };\n      }\n    }\n\n    if (this.deliberation && state.strategyRevision === null) {''')
# Add helper functions near existing helpers.
rep('src/core/mission/controller.ts',
'''function definedPatch<T extends Record<string, unknown>>(value: T): Partial<T> {''',
'''function validateBudget(budget: MissionBudget): void {\n  for (const [key, value] of Object.entries(budget)) {\n    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`Invalid mission budget ${key}`);\n  }\n}\n\nfunction validateUsage(usage: CostEvent["usage"]): void {\n  for (const [key, value] of Object.entries(usage)) {\n    if (key === "source" || value === undefined) continue;\n    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid measured usage ${key}`);\n  }\n}\n\nfunction budgetFingerprint(budget: MissionBudget): string {\n  return JSON.stringify(Object.fromEntries(Object.entries(budget).sort(([a], [b]) => a.localeCompare(b))));\n}\n\nfunction definedPatch<T extends Record<string, unknown>>(value: T): Partial<T> {''')

# Orchestrator obeys budget admission and never uses its internal wake cycle guard as a semantic plateau signal.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''      if (["completed", "cancelled", "failed", "blocked", "plateau"].includes(state.status)) return;''',
'''      if (["completed", "cancelled", "failed", "blocked", "plateau", "budget_exhausted"].includes(state.status)) return;''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[] }> = [];\n      for (const work of ready) {\n        if (dispatchable.length >= this.maxConcurrency) break;\n        if (work.purpose === "acquisition") { dispatchable.push({ work, capabilities: [] }); continue; }''',
'''      const budget = await this.controller.budgetAssessment(missionId);\n      const attemptSlots = budget.budget?.maxAttempts === undefined ? this.maxConcurrency : Math.max(0, budget.budget.maxAttempts - budget.usage.attempts);\n      const dispatchLimit = Math.min(this.maxConcurrency, budget.availableExecutionSlots ?? this.maxConcurrency, attemptSlots);\n      let acquisitionSlots = budget.capabilityAcquisitionRemaining ?? Number.POSITIVE_INFINITY;\n      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[] }> = [];\n      for (const work of ready) {\n        if (dispatchable.length >= dispatchLimit) break;\n        if (work.purpose === "acquisition") {\n          if (acquisitionSlots <= 0) continue;\n          acquisitionSlots -= 1;\n          dispatchable.push({ work, capabilities: [] });\n          continue;\n        }''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''    await this.controller.emit(missionId, "mission.status.changed", { status: "plateau", reason: "orchestrator cycle budget exhausted" }, { type: "system" }, `plateau:cycle-budget:${missionId}`);''',
'''    return;''')
# Persist authoritative usage after an execution result is available.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''      const { route: selectedRoute, result, approvalRef } = await this.executionRouter.execute({ work, route, capabilities, baseRequest });\n      const envelope = parseWorkerOutput(result.finalOutput);''',
'''      const { route: selectedRoute, result, approvalRef } = await this.executionRouter.execute({ work, route, capabilities, baseRequest });\n      if (result.usage && Object.entries(result.usage).some(([key, value]) => key !== "source" && typeof value === "number" && value > 0)) {\n        await this.controller.recordCost(work.missionId, {\n          id: `cost-${executionId}`, missionId: work.missionId, executionId, attemptId, usage: result.usage, recordedAt: new Date().toISOString()\n        });\n      }\n      const envelope = parseWorkerOutput(result.finalOutput);''')

# Runtime and API expose mission-level budget configuration at creation time without inventing defaults.
rep('src/runtime/mission-runtime.ts',
'''import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";''',
'''import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";\nimport type { MissionBudget } from "../core/domain/budget.ts";''')
rep('src/runtime/mission-runtime.ts',
'''  inspectionProviders?: InspectionProvider[];\n}''',
'''  inspectionProviders?: InspectionProvider[];\n  defaultBudget?: MissionBudget;\n}''')
rep('src/runtime/mission-runtime.ts',
'''  readonly inspection?: ArtifactInspectionService;''',
'''  readonly inspection?: ArtifactInspectionService;\n  readonly defaultBudget?: MissionBudget;''')
rep('src/runtime/mission-runtime.ts',
'''    this.artifacts = new FileArtifactStore(rootDir);''',
'''    this.artifacts = new FileArtifactStore(rootDir);\n    this.defaultBudget = options.defaultBudget;''')
# API budget hook.
rep('src/server/mission-api.ts',
'''  steer?: (missionId: string, message: string) => Promise<unknown>;\n}''',
'''  steer?: (missionId: string, message: string) => Promise<unknown>;\n  defaultBudget?: import("../core/domain/budget.ts").MissionBudget;\n}''')
rep('src/server/mission-api.ts',
'''        const state = await controller.createMission(missionId, body.userGoal ?? "");\n        await controller.runControllerCycle({ missionId, trigger: "mission_created" });''',
'''        const state = await controller.createMission(missionId, body.userGoal ?? "");\n        const budget = body.budget ?? options.defaultBudget;\n        if (budget) await controller.configureBudget(missionId, budget);\n        await controller.runControllerCycle({ missionId, trigger: "mission_created" });''')
rep('src/server/main.ts',
'''const server = createMissionApi(runtime.controller, runtime.events, { projections: runtime.projections, orchestrator: runtime.orchestrator, steer: (missionId, message) => runtime.steer(missionId, message) });''',
'''const server = createMissionApi(runtime.controller, runtime.events, { projections: runtime.projections, orchestrator: runtime.orchestrator, steer: (missionId, message) => runtime.steer(missionId, message), defaultBudget: runtime.defaultBudget });''')
PY

cat > tests/integration/budget-policy.test.ts <<'TS'
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  return { db, events, controller: new MissionController(events, { projections }) };
}

test("measured token cost exhausts budget while unknown usage consumes nothing", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-token-budget", "deliver artifact");
  await controller.configureBudget("m-token-budget", { tokenBudget: 100 });
  let assessment = await controller.budgetAssessment("m-token-budget");
  assert.equal(assessment.usage.totalTokens, 0);
  assert.equal(assessment.exhausted, false);
  await controller.recordCost("m-token-budget", { id: "c1", missionId: "m-token-budget", usage: { source: "host-reported", inputTokens: 60, outputTokens: 40 }, recordedAt: new Date().toISOString() });
  assessment = await controller.budgetAssessment("m-token-budget");
  assert.equal(assessment.usage.totalTokens, 100);
  assert.equal(assessment.exhausted, true);
  const cycle = await controller.runControllerCycle({ missionId: "m-token-budget", trigger: "execution_event" });
  assert.equal(cycle.status, "budget_exhausted");
  assert.notEqual(cycle.status, "plateau");
  db.close();
});

test("attempt budget is a hard admission limit and can be resumed by increasing budget", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-attempt-budget", "deliver artifact");
  await controller.configureBudget("m-attempt-budget", { maxAttempts: 1 });
  await controller.emit("m-attempt-budget", "attempt.created", { attempt: { id: "a1" } }, { type: "controller" });
  const exhausted = await controller.runControllerCycle({ missionId: "m-attempt-budget", trigger: "execution_event" });
  assert.equal(exhausted.status, "budget_exhausted");
  const resumed = await controller.configureBudget("m-attempt-budget", { maxAttempts: 2 });
  assert.equal(resumed.exhausted, false);
  assert.equal((await controller.state("m-attempt-budget")).status, "active");
  db.close();
});

test("concurrency budget limits slots without declaring budget exhausted", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-concurrency", "deliver artifact");
  await controller.configureBudget("m-concurrency", { maxConcurrentExecutions: 1 });
  await controller.emit("m-concurrency", "execution.created", { id: "e1", workItemId: "w1", attemptId: "a1", status: "created" }, { type: "controller" });
  await controller.emit("m-concurrency", "execution.started", { id: "e1", workItemId: "w1", attemptId: "a1" }, { type: "host" });
  const assessment = await controller.budgetAssessment("m-concurrency");
  assert.equal(assessment.availableExecutionSlots, 0);
  assert.equal(assessment.exhausted, false);
  db.close();
});
TS
