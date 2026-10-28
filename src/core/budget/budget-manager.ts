import type { EventStore } from "../events/event-store.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { MissionController } from "../mission/controller.ts";
import type { BudgetAssessment, BudgetFinding, BudgetLimit, BudgetMetric, BudgetUsage, MissionBudget } from "../domain/budget.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface BudgetRouteLike { requiresApproval: boolean }

export class BudgetManager {
  private readonly controller: MissionController;
  private readonly events: EventStore;
  private readonly projections: MissionProjectionReader;

  constructor(input: { controller: MissionController; events: EventStore; projections: MissionProjectionReader }) {
    this.controller = input.controller;
    this.events = input.events;
    this.projections = input.projections;
  }

  async configure(budget: MissionBudget): Promise<void> {
    validateBudget(budget);
    await this.controller.emit(
      budget.missionId,
      "budget.configured",
      { budget },
      { type: "controller" },
      `budget:${budget.missionId}:${budget.revision}`
    );
  }

  async current(missionId: string): Promise<MissionBudget | null> {
    const events = await this.events.list(missionId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.type !== "budget.configured") continue;
      const budget = (event.payload as { budget?: MissionBudget }).budget;
      if (budget) return budget;
    }
    return null;
  }

  async assess(missionId: string): Promise<BudgetAssessment> {
    const [budget, state, events, costs, acquisitions] = await Promise.all([
      this.current(missionId),
      this.controller.state(missionId),
      this.events.list(missionId),
      this.projections.listCostEvents(missionId),
      this.projections.listAcquisitionReceipts(missionId)
    ]);
    const usage: BudgetUsage = {
      observedExecutionMs: sum(costs.filter(cost => cost.category === "wall_time").map(cost => cost.quantity)),
      attempts: events.filter(event => event.type === "attempt.created").length,
      capabilityAcquisitions: acquisitions.length,
      externalSideEffects: sum(costs.filter(cost => cost.category === "external_side_effect").map(cost => cost.quantity)),
      concurrentExecutions: state.activeExecutionIds.length
    };
    if (!budget) {
      return { missionId, configured: false, usage, findings: [], hardExhausted: false, hardExhaustedMetrics: [], warnings: [] };
    }
    const findings = budget.limits.map(limit => finding(limit, usageValue(usage, limit.metric)));
    const hardExhaustedMetrics = findings
      .filter(item => item.enforcement === "hard" && item.exceeded)
      .map(item => item.metric);
    const warnings = findings.filter(item => item.warning).map(item => item.metric);
    const concurrency = budget.limits.find(limit => limit.metric === "concurrent_executions" && limit.enforcement === "hard")?.limit;
    return {
      missionId,
      budgetRevision: budget.revision,
      configured: true,
      usage,
      findings,
      hardExhausted: hardExhaustedMetrics.length > 0,
      hardExhaustedMetrics,
      warnings,
      maxConcurrentExecutions: concurrency
    };
  }

  async emitWarnings(assessment: BudgetAssessment): Promise<void> {
    if (!assessment.configured || assessment.budgetRevision === undefined) return;
    for (const metric of assessment.warnings) {
      const item = assessment.findings.find(finding => finding.metric === metric)!;
      await this.controller.emit(assessment.missionId, "budget.warning", {
        metric, used: item.used, limit: item.limit, remaining: item.remaining, budgetRevision: assessment.budgetRevision
      }, { type: "controller" }, `budget-warning:${assessment.missionId}:${assessment.budgetRevision}:${metric}`);
    }
  }

  isGloballyExhausted(assessment: BudgetAssessment): boolean {
    return assessment.hardExhaustedMetrics.some(metric => metric === "observed_execution_ms" || metric === "attempts");
  }

  canDispatch(work: WorkItem, assessment: BudgetAssessment, route?: BudgetRouteLike): boolean {
    const hard = new Set(assessment.hardExhaustedMetrics);
    if (hard.has("observed_execution_ms") || hard.has("attempts")) return false;
    if (work.purpose === "acquisition" && hard.has("capability_acquisitions")) return false;
    if (route?.requiresApproval && hard.has("external_side_effects")) return false;
    const maxConcurrent = assessment.maxConcurrentExecutions;
    if (maxConcurrent !== undefined && assessment.usage.concurrentExecutions >= maxConcurrent) return false;
    return true;
  }

  effectiveConcurrency(configuredMax: number, assessment: BudgetAssessment): number {
    const limit = assessment.maxConcurrentExecutions;
    if (limit === undefined) return configuredMax;
    return Math.max(0, Math.min(configuredMax, limit - assessment.usage.concurrentExecutions));
  }

  async markExhausted(assessment: BudgetAssessment, metrics?: BudgetMetric[]): Promise<void> {
    if (!assessment.configured || assessment.budgetRevision === undefined) return;
    const exhausted = metrics ?? assessment.hardExhaustedMetrics;
    if (exhausted.length === 0) return;
    await this.controller.emit(assessment.missionId, "budget.exhausted", {
      budgetRevision: assessment.budgetRevision,
      metrics: exhausted,
      usage: assessment.usage
    }, { type: "controller" }, `budget-exhausted:${assessment.missionId}:${assessment.budgetRevision}:${[...exhausted].sort().join(",")}`);
  }
}

function validateBudget(budget: MissionBudget): void {
  if (!budget.missionId) throw new Error("Budget requires missionId");
  if (!Number.isInteger(budget.revision) || budget.revision < 1) throw new Error("Budget revision must be a positive integer");
  const seen = new Set<BudgetMetric>();
  for (const limit of budget.limits) {
    if (seen.has(limit.metric)) throw new Error(`Duplicate budget metric: ${limit.metric}`);
    seen.add(limit.metric);
    if (!Number.isFinite(limit.limit) || limit.limit < 0) throw new Error(`Invalid budget limit for ${limit.metric}`);
    if (limit.warningAt !== undefined && (!Number.isFinite(limit.warningAt) || limit.warningAt < 0 || limit.warningAt > limit.limit)) {
      throw new Error(`Invalid warning threshold for ${limit.metric}`);
    }
  }
}

function finding(limit: BudgetLimit, used: number): BudgetFinding {
  const warningAt = limit.warningAt ?? limit.limit * 0.8;
  const exceeded = used >= limit.limit;
  return {
    metric: limit.metric,
    enforcement: limit.enforcement,
    limit: limit.limit,
    used,
    remaining: Math.max(0, limit.limit - used),
    exceeded,
    warning: !exceeded && used >= warningAt
  };
}

function usageValue(usage: BudgetUsage, metric: BudgetMetric): number {
  if (metric === "observed_execution_ms") return usage.observedExecutionMs;
  if (metric === "attempts") return usage.attempts;
  if (metric === "capability_acquisitions") return usage.capabilityAcquisitions;
  if (metric === "external_side_effects") return usage.externalSideEffects;
  return usage.concurrentExecutions;
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
