import type { SecurityAssessment } from "../domain/capability.ts";

export interface PolicyDecision {
  action: "allow" | "deny" | "require_approval" | "constrain" | "defer";
  reason: string;
  constraints: string[];
}

export class PolicyEngine {
  evaluateSecurity(assessment: SecurityAssessment): PolicyDecision {
    if (assessment.overall === "blocked") return { action: "deny", reason: "Blocked security finding", constraints: [] };
    if (assessment.overall === "high") return { action: "require_approval", reason: "High-risk capability requires user approval", constraints: [] };
    if (assessment.overall === "medium") return { action: "constrain", reason: "Medium-risk capability is sandbox-only", constraints: ["mission-local", "restricted-filesystem"] };
    return { action: "allow", reason: "Low-risk candidate may proceed to sandbox", constraints: ["mission-local"] };
  }
}
