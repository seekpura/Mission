export interface MissionBudget {
  tokenBudget?: number;
  monetaryBudgetUsd?: number;
  wallClockBudgetMs?: number;
  maxAttempts?: number;
  maxCapabilityAcquisitions?: number;
  maxConcurrentExecutions?: number;
}

export interface ExecutionUsage {
  inputTokens?: number;
  outputTokens?: number;
  monetaryCostUsd?: number;
  computeMs?: number;
  source: "host-reported" | "runtime-measured" | "user-provided";
}

export interface CostEvent {
  id: string;
  missionId: string;
  executionId?: string;
  attemptId?: string;
  usage: ExecutionUsage;
  recordedAt: string;
}

export interface BudgetUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  monetaryCostUsd: number;
  elapsedWallClockMs: number;
  attempts: number;
  capabilityAcquisitions: number;
  activeExecutions: number;
}

export interface BudgetAssessment {
  configured: boolean;
  exhausted: boolean;
  reasons: string[];
  budget?: MissionBudget;
  usage: BudgetUsage;
  availableExecutionSlots?: number;
  capabilityAcquisitionRemaining?: number;
}
