#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s: return
    if old not in s: raise SystemExit(f'anchor missing in {path}: {old[:160]!r}')
    p.write_text(s.replace(old,new,1))

replace('src/core/domain/mission.ts',
'''  | "plateau"\n  | "completed"''',
'''  | "plateau"\n  | "budget_exhausted"\n  | "completed"''')

replace('src/core/domain/event.ts',
'''  | "progress.observed"\n  | "capability.need.created"''',
'''  | "progress.observed"\n  | "budget.configured"\n  | "budget.warning"\n  | "budget.exhausted"\n  | "capability.need.created"''')

replace('src/core/events/state-projector.ts',
'''    case "mission.spec.revised":\n      s.missionSpecRevision = (event.payload as { revision: number }).revision;\n      break;''',
'''    case "mission.spec.revised":\n      s.missionSpecRevision = (event.payload as { revision: number }).revision;\n      break;\n    case "budget.configured":\n      if (s.status === "budget_exhausted") s.status = "active";\n      break;\n    case "budget.exhausted":\n      s.status = "budget_exhausted";\n      break;''')

replace('src/runtime/mission-runtime.ts',
'''import { WorkerKnowledgeIngestor } from "../core/knowledge/worker-knowledge-ingestor.ts";''',
'''import { WorkerKnowledgeIngestor } from "../core/knowledge/worker-knowledge-ingestor.ts";\nimport { BudgetManager } from "../core/budget/budget-manager.ts";\nimport type { MissionBudget } from "../core/domain/budget.ts";''')
replace('src/runtime/mission-runtime.ts',
'''  readonly knowledge: KnowledgeStalenessManager;''',
'''  readonly knowledge: KnowledgeStalenessManager;\n  readonly budget: BudgetManager;''')
replace('src/runtime/mission-runtime.ts',
'''    this.knowledge = new KnowledgeStalenessManager({ controller: this.controller, projections: this.projections });\n    if (options.host) {''',
'''    this.knowledge = new KnowledgeStalenessManager({ controller: this.controller, projections: this.projections });\n    this.budget = new BudgetManager({ controller: this.controller, events: this.events, projections: this.projections });\n    if (options.host) {''')
replace('src/runtime/mission-runtime.ts',
'''        knowledge: this.knowledge,\n        options: { maxConcurrency: options.maxConcurrency }''',
'''        knowledge: this.knowledge,\n        budget: this.budget,\n        options: { maxConcurrency: options.maxConcurrency }''')
replace('src/runtime/mission-runtime.ts',
'''  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {''',
'''  async configureBudget(budget: MissionBudget): Promise<void> {\n    await this.budget.configure(budget);\n    this.orchestrator?.wake(budget.missionId);\n  }\n\n  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {''')

replace('src/runtime/orchestration/mission-orchestrator.ts',
'''import type { KnowledgeStalenessManager } from "../../core/knowledge/knowledge-staleness-manager.ts";''',
'''import type { KnowledgeStalenessManager } from "../../core/knowledge/knowledge-staleness-manager.ts";\nimport type { BudgetManager } from "../../core/budget/budget-manager.ts";''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''  private readonly knowledge?: KnowledgeStalenessManager;\n  private readonly knowledgeSelector''',
'''  private readonly knowledge?: KnowledgeStalenessManager;\n  private readonly budget?: BudgetManager;\n  private readonly knowledgeSelector''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    knowledge?: KnowledgeStalenessManager;\n    assurance?: ArtifactAssurancePipeline;''',
'''    knowledge?: KnowledgeStalenessManager;\n    budget?: BudgetManager;\n    assurance?: ArtifactAssurancePipeline;''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    this.knowledge = input.knowledge;\n    this.assurance =''',
'''    this.knowledge = input.knowledge;\n    this.budget = input.budget;\n    this.assurance =''')

old='''  async runUntilQuiescent(missionId: string): Promise<void> {\n    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {\n      await this.knowledge?.scanFreshness(missionId);\n      await this.controller.runControllerCycle({ missionId, trigger: cycle === 0 ? "manual" : "execution_event" });\n      const state = await this.controller.state(missionId);\n      if (["completed", "cancelled", "failed", "blocked", "plateau"].includes(state.status)) return;\n      const ready = (await this.projections.listWorkItems(missionId))\n        .filter(work => work.status === "ready")\n        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));\n      if (ready.length === 0) return;\n      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[] }> = [];\n      for (const work of ready) {\n        if (dispatchable.length >= this.maxConcurrency) break;\n        if (work.purpose === "acquisition") { dispatchable.push({ work, capabilities: [] }); continue; }\n        const preparation = this.capabilityCoordinator ? await this.capabilityCoordinator.prepare(work) : { status: "ready" as const, capabilities: [], missingNeeds: [] };\n        if (preparation.status === "ready") dispatchable.push({ work, capabilities: preparation.capabilities });\n      }\n      if (dispatchable.length === 0) continue;\n      await Promise.all(dispatchable.map(item => this.executeWork(item.work, item.capabilities)));\n    }\n    await this.controller.emit(missionId, "mission.status.changed", { status: "plateau", reason: "orchestrator cycle budget exhausted" }, { type: "system" }, `plateau:cycle-budget:${missionId}`);\n  }\n\n  private async executeWork(work: WorkItem, capabilities: CapabilityDescriptor[] = []): Promise<void> {'''
new='''  async runUntilQuiescent(missionId: string): Promise<void> {\n    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {\n      await this.knowledge?.scanFreshness(missionId);\n      const beforeCycle = await this.controller.state(missionId);\n      if (beforeCycle.status === "budget_exhausted") return;\n      await this.controller.runControllerCycle({ missionId, trigger: cycle === 0 ? "manual" : "execution_event" });\n      const state = await this.controller.state(missionId);\n      if (["completed", "cancelled", "failed", "blocked", "plateau", "budget_exhausted"].includes(state.status)) return;\n\n      const budgetAssessment = this.budget ? await this.budget.assess(missionId) : undefined;\n      if (budgetAssessment && this.budget) {\n        await this.budget.emitWarnings(budgetAssessment);\n        if (this.budget.isGloballyExhausted(budgetAssessment)) {\n          await this.budget.markExhausted(budgetAssessment);\n          return;\n        }\n      }\n\n      const ready = (await this.projections.listWorkItems(missionId))\n        .filter(work => work.status === "ready")\n        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));\n      if (ready.length === 0) return;\n      const maxDispatch = budgetAssessment && this.budget\n        ? this.budget.effectiveConcurrency(this.maxConcurrency, budgetAssessment)\n        : this.maxConcurrency;\n      const reservation = this.budget?.emptyReservation();\n      const budgetBlockedMetrics = new Set<import("../../core/domain/budget.ts").BudgetMetric>();\n      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[]; route?: ExecutionRoute }> = [];\n      for (const work of ready) {\n        if (dispatchable.length >= maxDispatch) break;\n        if (work.purpose === "acquisition") {\n          if (budgetAssessment && this.budget && reservation && !this.budget.canReserve(work, budgetAssessment, reservation)) {\n            this.budget.exhaustedMetricsForBlockedWork(work, budgetAssessment).forEach(metric => budgetBlockedMetrics.add(metric));\n            continue;\n          }\n          if (this.budget && reservation) this.budget.reserve(work, reservation);\n          dispatchable.push({ work, capabilities: [] });\n          continue;\n        }\n        const preparation = this.capabilityCoordinator ? await this.capabilityCoordinator.prepare(work) : { status: "ready" as const, capabilities: [], missingNeeds: [] };\n        if (preparation.status !== "ready") continue;\n        const route = this.executionRouter?.select(work, preparation.capabilities);\n        if (budgetAssessment && this.budget && reservation && !this.budget.canReserve(work, budgetAssessment, reservation, route)) {\n          this.budget.exhaustedMetricsForBlockedWork(work, budgetAssessment, route).forEach(metric => budgetBlockedMetrics.add(metric));\n          continue;\n        }\n        if (this.budget && reservation) this.budget.reserve(work, reservation, route);\n        dispatchable.push({ work, capabilities: preparation.capabilities, route });\n      }\n      if (dispatchable.length === 0) {\n        if (budgetAssessment && this.budget && budgetBlockedMetrics.size > 0) {\n          await this.budget.markExhausted(budgetAssessment, [...budgetBlockedMetrics]);\n          return;\n        }\n        continue;\n      }\n      await Promise.all(dispatchable.map(item => this.executeWork(item.work, item.capabilities, item.route)));\n    }\n    await this.controller.emit(missionId, "mission.status.changed", { status: "plateau", reason: "orchestrator cycle budget exhausted" }, { type: "system" }, `plateau:cycle-budget:${missionId}`);\n  }\n\n  private async executeWork(work: WorkItem, capabilities: CapabilityDescriptor[] = [], reservedRoute?: ExecutionRoute): Promise<void> {'''
replace('src/runtime/orchestration/mission-orchestrator.ts', old, new)
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    const selectedRoute: ExecutionRoute = this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", cancellable: true, sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }, resourceRequest: {}, requiresApproval: false };''',
'''    const selectedRoute: ExecutionRoute = reservedRoute ?? this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", cancellable: true, sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }, resourceRequest: {}, requiresApproval: false };''')
PY
