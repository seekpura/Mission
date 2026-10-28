import type { CapabilityNeed } from "../domain/capability.ts";
import type { InvocationReceipt, InvocationRoute } from "../domain/invocation.ts";
import type { WorkExecutionConstraints } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";
import type { GapDiagnosis } from "./deliberation-provider.ts";

export interface RepairEnactmentPlan {
  executionConstraints?: WorkExecutionConstraints;
  replacementNeed?: CapabilityNeed;
  failedCapabilityRef?: string;
  failedExecutorRef?: string;
}

export class RepairEnactmentPolicy {
  plan(input: {
    missionId: string;
    gap: Gap;
    diagnosis: GapDiagnosis;
    invocationReceipts: InvocationReceipt[];
    capabilityNeeds: CapabilityNeed[];
    repairSequence: number;
  }): RepairEnactmentPlan {
    const related = input.invocationReceipts
      .filter(receipt => receipt.result !== "succeeded")
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const latest = related[0] ?? [...input.invocationReceipts].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

    if (input.diagnosis.intervention === "replace_executor") {
      const failedExecutorRef = latest?.targetRef;
      return {
        failedExecutorRef,
        executionConstraints: {
          forceFreshAgent: true,
          excludeExecutorRefs: failedExecutorRef ? [failedExecutorRef] : [],
          avoidRouteKinds: latest ? [latest.route] : [],
          sourceDecisionReason: input.diagnosis.rootCause
        }
      };
    }

    if (input.diagnosis.intervention !== "replace_capability") return {};

    const failedCapabilityRef = latest?.targetRef ?? latest?.capabilityRefs[0];
    if (!failedCapabilityRef) {
      return {
        executionConstraints: {
          excludeCapabilityRefs: [],
          sourceDecisionReason: input.diagnosis.rootCause
        }
      };
    }

    const originalNeed = input.capabilityNeeds.find(need => need.resolvedCapabilityRef === failedCapabilityRef);
    const replacementNeed: CapabilityNeed = {
      id: `replacement-${input.gap.id}-${input.repairSequence}`,
      missionId: input.missionId,
      objective: `Replace capability ${failedCapabilityRef} for gap ${input.gap.id}: ${input.diagnosis.rootCause}`,
      requiredFunctions: originalNeed?.requiredFunctions ?? ["provide an alternative implementation for the failed capability"],
      desiredInputs: originalNeed?.desiredInputs ?? [],
      desiredOutputs: originalNeed?.desiredOutputs ?? [],
      purpose: originalNeed?.purpose ?? "production",
      urgency: "blocking",
      acquisitionAllowed: originalNeed?.acquisitionAllowed ?? true,
      maxRisk: originalNeed?.maxRisk ?? "medium",
      requirementRefs: [...new Set([...(originalNeed?.requirementRefs ?? []), ...input.gap.requirementRefs])],
      gapRefs: [...new Set([...(originalNeed?.gapRefs ?? []), input.gap.id])],
      status: "checking-installed",
      replacesCapabilityRef: failedCapabilityRef
    };
    return {
      failedCapabilityRef,
      replacementNeed,
      executionConstraints: {
        excludeCapabilityRefs: [failedCapabilityRef],
        preferredCapabilityNeedRefs: [replacementNeed.id],
        sourceDecisionReason: input.diagnosis.rootCause
      }
    };
  }
}

export function routeAvoided(route: InvocationRoute, constraints?: WorkExecutionConstraints): boolean {
  return constraints?.avoidRouteKinds?.includes(route) ?? false;
}
