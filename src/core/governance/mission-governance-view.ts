import type { BudgetAssessment, MissionBudget } from "../domain/budget.ts";
import type { AuditRecord, CapabilityTrustProfile, CompletionRecord, CostEvent } from "../domain/governance.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import type { BudgetManager } from "../budget/budget-manager.ts";

export interface MissionGovernanceView {
  missionId: string;
  budget: { policy: MissionBudget | null; assessment: BudgetAssessment };
  observedCost: {
    executionWallTimeMs: number;
    externalSideEffects: number;
    monetaryEstimate?: number;
    monetaryCoverage: "unavailable" | "partial" | "complete";
  };
  trust: CapabilityTrustProfile[];
  completion: CompletionRecord | null;
  recentAudit: AuditRecord[];
}

export class MissionGovernanceViewBuilder {
  private readonly projections: MissionProjectionReader;
  private readonly budget: BudgetManager;

  constructor(input: { projections: MissionProjectionReader; budget: BudgetManager }) {
    this.projections = input.projections;
    this.budget = input.budget;
  }

  async build(missionId: string, auditLimit = 20): Promise<MissionGovernanceView> {
    const [policy, assessment, costs, audit, trust, completions] = await Promise.all([
      this.budget.current(missionId),
      this.budget.assess(missionId),
      this.projections.listCostEvents(missionId),
      this.projections.listAuditRecords(missionId),
      this.projections.listCapabilityTrustProfiles(missionId),
      this.projections.listCompletionRecords(missionId)
    ]);
    const wallTime = sum(costs.filter(cost => cost.category === "wall_time").map(cost => cost.quantity));
    const sideEffects = sum(costs.filter(cost => cost.category === "external_side_effect").map(cost => cost.quantity));
    const monetary = monetarySummary(costs);
    return {
      missionId,
      budget: { policy, assessment },
      observedCost: {
        executionWallTimeMs: wallTime,
        externalSideEffects: sideEffects,
        monetaryEstimate: monetary.value,
        monetaryCoverage: monetary.coverage
      },
      trust,
      completion: completions.at(-1) ?? null,
      recentAudit: audit.slice(-Math.max(0, auditLimit)).reverse()
    };
  }
}

function monetarySummary(costs: CostEvent[]): { value?: number; coverage: "unavailable" | "partial" | "complete" } {
  if (costs.length === 0) return { coverage: "unavailable" };
  const priced = costs.filter(cost => cost.monetaryEstimate !== undefined);
  if (priced.length === 0) return { coverage: "unavailable" };
  return {
    value: sum(priced.map(cost => cost.monetaryEstimate ?? 0)),
    coverage: priced.length === costs.length ? "complete" : "partial"
  };
}

function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
