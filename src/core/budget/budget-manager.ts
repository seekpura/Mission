import type { EventStore } from "../events/event-store.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { MissionController } from "../mission/controller.ts";
import type { BudgetAssessment, BudgetFinding, BudgetLimit, BudgetMetric, BudgetUsage, MissionBudget } from "../domain/budget.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface BudgetRouteLike { requiresApproval: boolean }
export interface BudgetReservation {
  attempts: number;
  capabilityAcquisitions: number;
  potentialExternalSideEffects: number;
  concurrentExecutions: number;
}

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

  emptyReservation(): BudgetReservation {
    return { attempts: 0, capabilityAcquisitions: 0, potentialExternalSideEffects: 0, concurrentExecutions: 0 };
  }

  canReserve(work: WorkItem, assessment: BudgetAssessment, reservation: BudgetReservation, route?: BudgetRouteLike): boolean {
    if (wouldHitHardLimit(assessment, "observed_execution_ms", assessment.usage.observedExecutionMs, 0)) return false;
    if (wouldHitHardLimit(assessment, "attempts", assessment.usage.attempts, reservation.attempts + 1)) return false;
    if (work.purpose === "acquisition" && wouldHitHardLimit(
      assessment, "capability_acquisitions", assessment.usage.capabilityAcquisitions, reservation.capabilityAcquisitions + 1
    )) return false;
    if (route?.requiresApproval && wouldHitHardLimit(
      assessment, "external_side_effects", assessment.usage.externalSideEffects, reservation.potentialExternalSideEffects + 1
    )) return false;
    if (wouldHitHardLimit(
      assessment, "concurrent_executions", assessment.usage.concurrentExecutions, reservation.concurrentExecutions + 1
    )) return false;
    return true;
  }

  reserve(work: WorkItem, reservation: BudgetReservation, route?: BudgetRouteLike): void {
    reservation.attempts += 1;
    reservation.concurrentExecutions += 1;
    if (work.purpose === "acquisition") reservation.capabilityAcquisitions += 1;
    if (route?.requiresApproval) reservation.potentialExternalSideEffects += 1;
  }

  effectiveConcurrency(configuredMax: number, assessment: BudgetAssessment): number {
    const limit = assessment.maxConcurrentExecutions;
    if (limit === undefined) return configuredMax;
    return Math.max(0, Math.min(configuredMax, limit - assessment.usage.concurrentExecutions));
  }

  exhaustedMetricsForBlockedWork(work: WorkItem, assessment: BudgetAssessment, route?: BudgetRouteLike): BudgetMetric[] {
    const metrics: BudgetMetric[] = [];
    const hard = (metric: BudgetMetric) => assessment.findings.find(item => item.metric === metric && item.enforcement === "hard");
    if (hard("observed_execution_ms")?.exceeded) metrics.push("observed_execution_ms");
    if (hard("attempts")?.exceeded) metrics.push("attempts");
    if (work.purpose === "acquisition" && hard("capability_acquisitions")?.exceeded) metrics.push("capability_acquisitions");
    if (route?.requiresApproval && hard("external_side_effects")?.exceeded) metrics.push("external_side_effects");
    if (hard("concurrent_executions")?.exceeded) metrics.push("concurrent_executions");
    return metrics;
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

function hardLimit(assessment: BudgetAssessment, metric: BudgetMetric): number | undefined {
  return assessment.findings.find(item => item.metric === metric && item.enforcement === "hard")?.limit;
}

function wouldHitHardLimit(assessment: BudgetAssessment, metric: BudgetMetric, used: number, requested: number): boolean {
  const limit = hardLimit(assessment, metric);
  if (limit === undefined) return false;
  return used + requested > limit || (requested === 0 && used >= limit);
}

function usageValue(usage: BudgetUsage, metric: BudgetMetric): number {
  if (metric === "observed_execution_ms") return usage.observedExecutionMs;
  if (metric === "attempts") return usage.attempts;
  if (metric === "capability_acquisitions") return usage.capabilityAcquisitions;
  if (metric === "external_side_effects") return usage.externalSideEffects;
  return usage.concurrentExecutions;
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
