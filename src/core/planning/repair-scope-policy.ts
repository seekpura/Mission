import type { GapDiagnosis, RepairScope } from "./deliberation-provider.ts";

const SCOPE_ORDER: RepairScope[] = ["attempt", "work_item", "executor", "capability", "graph", "strategy"];

export interface RepairScopeContext {
  findingRefs?: string[];
  evidenceRefs?: string[];
  priorRepairCount?: number;
  minimumRepairScope?: RepairScope;
}

export function normalizeGapDiagnosis(diagnosis: GapDiagnosis, context: RepairScopeContext = {}): GapDiagnosis {
  const hypotheses = diagnosis.hypotheses ?? [];
  const evidenceRefs = unique([...(diagnosis.evidenceRefs ?? []), ...(context.evidenceRefs ?? []), ...hypotheses.flatMap(item => item.evidenceRefs)]);
  const supportRefs = unique([...(context.findingRefs ?? []), ...evidenceRefs, ...hypotheses.flatMap(item => item.findingRefs)]);
  const requested = diagnosis.repairScope ?? scopeForIntervention(diagnosis.intervention);
  let repairScope = constrainScope(requested, diagnosis.confidence, supportRefs.length);
  if ((context.priorRepairCount ?? 0) > 0 && repairScope === "attempt") repairScope = "work_item";
  if (context.minimumRepairScope && scopeRank(repairScope) < scopeRank(context.minimumRepairScope)) {
    repairScope = context.minimumRepairScope;
  }
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

function scopeRank(scope: RepairScope): number {
  return SCOPE_ORDER.indexOf(scope);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
