import type { EventStore } from "../events/event-store.ts";
import type { MissionState } from "../domain/mission.ts";
import type { BudgetAssessment, BudgetUsage, CostEvent, MissionBudget } from "../domain/budget.ts";
import type { MissionReadModel } from "../mission/mission-read-model.ts";

export class BudgetTracker {
  private readonly store: EventStore;
  private readonly readModel: MissionReadModel;

  constructor(store: EventStore, readModel: MissionReadModel) {
    this.store = store;
    this.readModel = readModel;
  }

  async configuredBudget(missionId: string): Promise<MissionBudget | undefined> {
    const events = await this.store.list(missionId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.type !== "budget.configured") continue;
      return ((event.payload as { budget?: MissionBudget }).budget ?? event.payload) as MissionBudget;
    }
    return undefined;
  }

  async usage(missionId: string, state: MissionState, now = Date.now()): Promise<BudgetUsage> {
    const events = await this.store.list(missionId);
    const created = events.find(event => event.type === "mission.created");
    const costEvents = events
      .filter(event => event.type === "cost.recorded")
      .map(event => ((event.payload as { cost?: CostEvent }).cost ?? event.payload) as CostEvent);
    const attempts = events.filter(event => event.type === "attempt.created").length;
    const capabilityAcquisitions = events
      .filter(event => event.type === "capability.acquisition.receipt")
      .map(event => (event.payload as any).receipt ?? event.payload)
      .filter(receipt => receipt?.status === "activated").length;
    const inputTokens = costEvents.reduce((sum, item) => sum + nonNegative(item.usage.inputTokens), 0);
    const outputTokens = costEvents.reduce((sum, item) => sum + nonNegative(item.usage.outputTokens), 0);
    const monetaryCostUsd = costEvents.reduce((sum, item) => sum + nonNegative(item.usage.monetaryCostUsd), 0);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      monetaryCostUsd,
      elapsedWallClockMs: created ? Math.max(0, now - Date.parse(created.createdAt)) : 0,
      attempts,
      capabilityAcquisitions,
      activeExecutions: state.activeExecutionIds.length
    };
  }

  async assess(missionId: string, state: MissionState, now = Date.now()): Promise<BudgetAssessment> {
    const budget = await this.configuredBudget(missionId);
    const usage = await this.usage(missionId, state, now);
    if (!budget) return { configured: false, exhausted: false, reasons: [], usage };

    const reasons: string[] = [];
    if (budget.tokenBudget !== undefined && usage.totalTokens >= budget.tokenBudget) reasons.push(`token budget exhausted (${usage.totalTokens}/${budget.tokenBudget})`);
    if (budget.monetaryBudgetUsd !== undefined && usage.monetaryCostUsd >= budget.monetaryBudgetUsd) reasons.push(`monetary budget exhausted (${usage.monetaryCostUsd}/${budget.monetaryBudgetUsd} USD)`);
    if (budget.wallClockBudgetMs !== undefined && usage.elapsedWallClockMs >= budget.wallClockBudgetMs) reasons.push(`wall-clock budget exhausted (${usage.elapsedWallClockMs}/${budget.wallClockBudgetMs} ms)`);
    if (budget.maxAttempts !== undefined && usage.attempts >= budget.maxAttempts) reasons.push(`attempt budget exhausted (${usage.attempts}/${budget.maxAttempts})`);

    const needs = await this.readModel.capabilityNeeds(missionId);
    const acquisitionStillNeeded = needs.some(need => need.urgency === "blocking" && !["available"].includes(need.status ?? "checking-installed"));
    if (budget.maxCapabilityAcquisitions !== undefined && acquisitionStillNeeded && usage.capabilityAcquisitions >= budget.maxCapabilityAcquisitions) {
      reasons.push(`capability acquisition budget exhausted (${usage.capabilityAcquisitions}/${budget.maxCapabilityAcquisitions})`);
    }

    const availableExecutionSlots = budget.maxConcurrentExecutions === undefined
      ? undefined
      : Math.max(0, budget.maxConcurrentExecutions - usage.activeExecutions);
    const capabilityAcquisitionRemaining = budget.maxCapabilityAcquisitions === undefined
      ? undefined
      : Math.max(0, budget.maxCapabilityAcquisitions - usage.capabilityAcquisitions);
    return {
      configured: true,
      exhausted: reasons.length > 0,
      reasons,
      budget,
      usage,
      availableExecutionSlots,
      capabilityAcquisitionRemaining
    };
  }
}

function nonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
