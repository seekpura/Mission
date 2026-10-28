export type BudgetEnforcement = "advisory" | "hard";
export type BudgetMetric =
  | "observed_execution_ms"
  | "attempts"
  | "capability_acquisitions"
  | "external_side_effects"
  | "concurrent_executions";

export interface BudgetLimit {
  metric: BudgetMetric;
  limit: number;
  enforcement: BudgetEnforcement;
  warningAt?: number;
}

export interface MissionBudget {
  missionId: string;
  revision: number;
  limits: BudgetLimit[];
  createdAt: string;
}

export interface BudgetUsage {
  observedExecutionMs: number;
  attempts: number;
  capabilityAcquisitions: number;
  externalSideEffects: number;
  concurrentExecutions: number;
}

export interface BudgetFinding {
  metric: BudgetMetric;
  enforcement: BudgetEnforcement;
  limit: number;
  used: number;
  remaining: number;
  exceeded: boolean;
  warning: boolean;
}

export interface BudgetAssessment {
  missionId: string;
  budgetRevision?: number;
  configured: boolean;
  usage: BudgetUsage;
  findings: BudgetFinding[];
  hardExhausted: boolean;
  hardExhaustedMetrics: BudgetMetric[];
  warnings: BudgetMetric[];
  maxConcurrentExecutions?: number;
}
