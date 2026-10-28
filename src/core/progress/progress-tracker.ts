import { createHash } from "node:crypto";
import type { EventStore } from "../events/event-store.ts";
import type { MissionState } from "../domain/mission.ts";
import type { MissionProgressSnapshot, PlateauAssessment, PlateauContext } from "../domain/progress.ts";
import type { RepairScope } from "../planning/deliberation-provider.ts";
import type { MissionReadModel } from "../mission/mission-read-model.ts";

const SCOPE_ORDER: RepairScope[] = ["attempt", "work_item", "executor", "capability", "graph", "strategy"];

export class MissionProgressTracker {
  private readonly store: EventStore;
  private readonly readModel: MissionReadModel;

  constructor(store: EventStore, readModel: MissionReadModel) {
    this.store = store;
    this.readModel = readModel;
  }

  async snapshot(missionId: string, state: MissionState): Promise<MissionProgressSnapshot> {
    const [requirements, gaps, artifacts, workItems, receipts] = await Promise.all([
      this.readModel.requirements(missionId),
      this.readModel.gaps(missionId),
      this.readModel.artifacts(missionId),
      this.readModel.workItems(missionId),
      this.readModel.invocationReceipts(missionId)
    ]);
    const required = requirements.filter(requirement => requirement.priority === "critical" || requirement.priority === "required");
    const blocking = gaps.filter(gap => ["open", "working", "blocked"].includes(gap.status) && (gap.severity === "critical" || gap.severity === "major"));
    const open = gaps.filter(gap => ["open", "working", "blocked"].includes(gap.status));
    const verified = artifacts.filter(artifact => ["verified", "integrated", "final"].includes(artifact.status));
    const finalRefs = [...state.finalArtifactRefs].sort();
    const meaningful = {
      requiredSatisfied: required.filter(requirement => requirement.status === "satisfied").map(requirement => requirement.id).sort(),
      blockingGaps: blocking.map(gap => `${gap.id}:${gap.severity}`).sort(),
      openGaps: open.map(gap => gap.id).sort(),
      verifiedArtifacts: verified.map(artifact => `${artifact.id}@${artifact.version}:${artifact.contentHash}`).sort(),
      finalRefs
    };
    return {
      missionId,
      missionRevision: state.revision,
      requiredSatisfied: meaningful.requiredSatisfied.length,
      requiredTotal: required.length,
      blockingGapRefs: blocking.map(gap => gap.id).sort(),
      openGapRefs: open.map(gap => gap.id).sort(),
      verifiedArtifactRefs: verified.map(artifact => `${artifact.id}@${artifact.version}`).sort(),
      finalArtifactRefs: finalRefs,
      failedInvocationCount: receipts.filter(receipt => receipt.result !== "succeeded").length,
      repairWorkCount: workItems.filter(work => work.purpose === "repair").length,
      signature: createHash("sha256").update(JSON.stringify(meaningful)).digest("hex"),
      observedAt: new Date().toISOString()
    };
  }

  async history(missionId: string): Promise<MissionProgressSnapshot[]> {
    return (await this.store.list(missionId))
      .filter(event => event.type === "progress.observed")
      .map(event => ((event.payload as { snapshot?: MissionProgressSnapshot }).snapshot ?? event.payload) as MissionProgressSnapshot);
  }

  async assess(missionId: string, state: MissionState, current: MissionProgressSnapshot): Promise<PlateauAssessment> {
    const [history, capabilityNeeds, events] = await Promise.all([
      this.history(missionId),
      this.readModel.capabilityNeeds(missionId),
      this.store.list(missionId)
    ]);
    const waitingReason = state.pendingApprovalIds.length > 0 ? "approval" as const
      : state.activeExecutionIds.length > 0 ? "execution" as const
      : state.readyWorkItemIds.length > 0 || state.verifyingWorkItemIds.length > 0 ? "ready-work" as const
      : capabilityNeeds.some(need => ["checking-installed", "discovering", "evaluating", "acquiring"].includes(need.status ?? "")) ? "capability" as const
      : undefined;

    const consecutive = consecutiveSameSignature([...history, current]);
    const repairScopes = events
      .filter(event => event.type === "decision.created")
      .map(event => (event.payload as any)?.decision)
      .filter(decision => decision && decision.gapRefs?.some((gap: string) => current.blockingGapRefs.includes(gap)))
      .map(decision => scopeFromDecisionType(String(decision.type)))
      .filter((scope): scope is RepairScope => !!scope);
    const context: PlateauContext = {
      stagnationCount: consecutive,
      priorRepairCount: current.repairWorkCount,
      priorRepairScopes: repairScopes,
      highestRepairScope: highestScope(repairScopes),
      lastProgressAt: [...history].reverse().find(snapshot => snapshot.signature !== current.signature)?.observedAt,
      waitingReason
    };

    if (waitingReason) return { state: "waiting", reason: `Mission has legitimate pending ${waitingReason}; plateau detection suspended`, context };
    if (current.blockingGapRefs.length === 0) return { state: "progressing", reason: "No blocking gap is currently preventing acceptance", context };
    if (consecutive < 3) return { state: "progressing", reason: "Recent observations do not yet establish sustained stagnation", context };
    const strategyAttempts = repairScopes.filter(scope => scope === "strategy").length;
    if (consecutive >= 5 && strategyAttempts >= 1 && current.repairWorkCount >= 4) {
      return { state: "plateau", reason: "Acceptance metrics remained unchanged after repeated repairs including strategy-level intervention", context };
    }
    return { state: "stalled", reason: "Acceptance metrics are unchanged across repeated repair cycles; diagnosis should consider a broader intervention", context };
  }
}

function consecutiveSameSignature(snapshots: MissionProgressSnapshot[]): number {
  if (snapshots.length === 0) return 0;
  const signature = snapshots[snapshots.length - 1]!.signature;
  let count = 0;
  for (let index = snapshots.length - 1; index >= 0; index--) {
    if (snapshots[index]!.signature !== signature) break;
    count += 1;
  }
  return count;
}

function scopeFromDecisionType(type: string): RepairScope | undefined {
  if (type === "retry") return "attempt";
  if (type === "revise_work") return "work_item";
  if (type === "replace_executor") return "executor";
  if (type === "replace_capability") return "capability";
  if (type === "replan_local") return "graph";
  if (type === "revise_strategy") return "strategy";
  return undefined;
}

function highestScope(scopes: RepairScope[]): RepairScope | undefined {
  let highest = -1;
  for (const scope of scopes) highest = Math.max(highest, SCOPE_ORDER.indexOf(scope));
  return highest >= 0 ? SCOPE_ORDER[highest] : undefined;
}
