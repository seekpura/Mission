import { randomUUID } from "node:crypto";
import type { EventStore } from "../events/event-store.ts";
import { OptimisticConcurrencyError } from "../events/event-store.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import { projectMissionState } from "../events/state-projector.ts";
import type { MissionEvent, MissionEventType } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { MissionDecision } from "../domain/decision.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";
import type { DeliberationProvider, CompletionChallenge } from "../planning/deliberation-provider.ts";

export interface ControllerCycleInput {
  missionId: string;
  trigger: "mission_created" | "user_steering" | "execution_event" | "verification_event" | "approval_event" | "retry_timer" | "manual";
}

export interface ControllerCycleResult {
  missionRevision: number;
  decisionsCreated: string[];
  workItemsCreated: string[];
  executionsDispatched: string[];
  verificationsScheduled: string[];
  status: MissionState["status"];
}

export interface MissionControllerDependencies {
  projections?: MissionProjectionReader;
  deliberation?: DeliberationProvider;
  concurrencyRetries?: number;
}

export class MissionController {
  private readonly store: EventStore;
  private readonly projections?: MissionProjectionReader;
  private readonly deliberation?: DeliberationProvider;
  private readonly concurrencyRetries: number;

  constructor(store: EventStore, dependencies: MissionControllerDependencies = {}) {
    this.store = store;
    this.projections = dependencies.projections;
    this.deliberation = dependencies.deliberation;
    this.concurrencyRetries = dependencies.concurrencyRetries ?? 5;
  }

  async emit(
    missionId: string,
    type: MissionEventType,
    payload: unknown,
    actor: { type: "user" | "controller" | "planner" | "worker" | "verifier" | "host" | "system"; id?: string } = { type: "controller" },
    idempotencyKey?: string
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.concurrencyRetries; attempt++) {
      const expected = await this.store.lastSequence(missionId);
      try {
        return await this.store.append({
          id: randomUUID(),
          missionId,
          type,
          actor,
          payload,
          idempotencyKey,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        }, expected);
      } catch (error) {
        if (!(error instanceof OptimisticConcurrencyError)) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Mission event append exhausted concurrency retries");
  }

  async createMission(missionId: string, userGoal: string) {
    if (await this.store.lastSequence(missionId) > 0) return this.state(missionId);
    await this.emit(missionId, "mission.created", { missionId, userGoal }, { type: "user" }, `mission-created:${missionId}`);
    await this.emit(missionId, "mission.spec.revised", { revision: 1, objective: userGoal }, { type: "controller" }, `mission-spec:${missionId}:1`);
    await this.emit(missionId, "acceptance.created", { revision: 1, requirements: [], requiredArtifacts: [], requiredValidations: [] }, { type: "controller" }, `acceptance:${missionId}:1`);
    return this.state(missionId);
  }

  async proposeWork(work: WorkItem) {
    const hasReason = work.purpose === "exploration" || work.requirementRefs.length > 0 || work.gapRefs.length > 0 || work.inputArtifactRefs.length > 0 || work.capabilityNeedRefs.length > 0;
    if (!hasReason) throw new Error(`Orphan work item rejected: ${work.id}`);
    await this.emit(work.missionId, "work.created", { id: work.id, status: work.status, workstreamId: work.workstreamId, work }, { type: work.createdBy === "verifier" ? "verifier" : "planner" }, `work-created:${work.id}`);
  }

  async steer(missionId: string, message: string) {
    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });
    return this.state(missionId);
  }

  async openGap(missionId: string, payload: { id: string; severity: "critical" | "major" | "minor"; description: string; blocking?: boolean; category?: Gap["category"]; requirementRefs?: string[]; artifactRefs?: string[]; findingRefs?: string[] }) {
    await this.emit(missionId, "gap.opened", payload, { type: "verifier" }, `gap:${payload.id}`);
  }

  async resolveGap(missionId: string, gapId: string) {
    await this.emit(missionId, "gap.resolved", { id: gapId }, { type: "verifier" }, `gap-resolved:${gapId}`);
  }

  async validateArtifact(missionId: string, artifactRef: string, final = false) {
    await this.emit(missionId, "artifact.validated", { artifactRef, final }, { type: "verifier" }, `artifact-validated:${artifactRef}:${final}`);
  }

  async completeIfEligible(missionId: string): Promise<MissionState> {
    const state = await this.state(missionId);
    if (!this.passesDeterministicCompletionGate(state)) return state;

    if (this.deliberation) {
      const challenge = await this.deliberation.challengeCompletion({ state });
      if (challenge.blockingObjection) {
        await this.materializeCompletionObjections(missionId, state, challenge);
        return this.state(missionId);
      }
    }

    await this.emit(
      missionId,
      "mission.completed",
      { reason: "deterministic completion gate and completion challenge passed" },
      { type: "controller" },
      `mission-completed:${state.revision}`
    );
    return this.state(missionId);
  }

  async runControllerCycle(input: ControllerCycleInput): Promise<ControllerCycleResult> {
    const decisionsCreated: string[] = [];
    const workItemsCreated: string[] = [];
    let state = await this.state(input.missionId);

    if (this.deliberation && state.strategyRevision === null) {
      const proposal = await this.deliberation.composeStrategy({ state, userGoal: await this.currentUserGoal(input.missionId) });
      await this.emit(input.missionId, "strategy.created", proposal, { type: "planner" }, `strategy:${input.missionId}:${proposal.revision}`);
      state = await this.state(input.missionId);
    }

    const openGaps = await this.listOpenGaps(input.missionId);
    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));
    if (this.deliberation && blockingGap) {
      const existingRepair = (await this.listWorkItems(input.missionId)).find(work =>
        work.gapRefs.includes(blockingGap.id) && !["succeeded", "invalidated", "superseded", "abandoned"].includes(work.status)
      );
      if (!existingRepair) {
        const diagnosis = await this.deliberation.diagnoseGap({ state, gap: blockingGap });
        const decision = this.decisionForDiagnosis(input.missionId, blockingGap, diagnosis);
        await this.emit(input.missionId, "decision.created", { decision }, { type: "controller" }, `decision:${blockingGap.id}:${diagnosis.intervention}`);
        decisionsCreated.push(decision.id);
        if (["retry", "revise_work", "replan_local", "replace_capability"].includes(diagnosis.intervention)) {
          const repair = this.repairWorkItem(state, blockingGap, diagnosis.rootCause);
          await this.proposeWork(repair);
          workItemsCreated.push(repair.id);
        }
        state = await this.state(input.missionId);
      }
    }

    if (this.deliberation && this.shouldPlanFrontier(state)) {
      const frontier = await this.deliberation.planFrontier({ state, userGoal: await this.currentUserGoal(input.missionId), openGaps });
      if (frontier.graphRevision > state.graphRevision) {
        await this.emit(input.missionId, "graph.revised", { revision: frontier.graphRevision }, { type: "planner" }, `graph:${input.missionId}:${frontier.graphRevision}`);
      }
      for (const work of frontier.workItems) {
        await this.proposeWork(work);
        workItemsCreated.push(work.id);
      }
      state = await this.state(input.missionId);
    }

    const after = await this.completeIfEligible(input.missionId);
    return {
      missionRevision: after.revision,
      decisionsCreated,
      workItemsCreated,
      executionsDispatched: [],
      verificationsScheduled: [],
      status: after.status
    };
  }

  async state(missionId: string) {
    const projected = await this.projections?.getMissionState(missionId);
    if (projected && projected.lastEventSequence === await this.store.lastSequence(missionId)) return projected;
    return projectMissionState(missionId, await this.store.list(missionId));
  }

  private passesDeterministicCompletionGate(state: MissionState): boolean {
    if (state.status === "completed") return false;
    if (state.blockingGapIds.length > 0) return false;
    if (state.readyWorkItemIds.length > 0 || state.activeWorkItemIds.length > 0 || state.verifyingWorkItemIds.length > 0 || state.activeExecutionIds.length > 0) return false;
    if (state.finalArtifactRefs.length === 0) return false;
    return true;
  }

  private shouldPlanFrontier(state: MissionState): boolean {
    return state.status !== "completed"
      && state.blockingGapIds.length === 0
      && state.readyWorkItemIds.length === 0
      && state.activeWorkItemIds.length === 0
      && state.verifyingWorkItemIds.length === 0
      && state.activeExecutionIds.length === 0
      && state.finalArtifactRefs.length === 0;
  }

  private async currentUserGoal(missionId: string): Promise<string> {
    const events = await this.store.list(missionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type !== "mission.spec.revised") continue;
      const objective = (event.payload as { objective?: string }).objective;
      if (objective) return objective;
    }
    const created = events.find(event => event.type === "mission.created");
    return (created?.payload as { userGoal?: string } | undefined)?.userGoal ?? "";
  }

  private async listWorkItems(missionId: string): Promise<WorkItem[]> {
    if (this.projections) return this.projections.listWorkItems(missionId);
    const map = new Map<string, WorkItem>();
    for (const event of await this.store.list(missionId)) {
      const payload = event.payload as any;
      if (event.type === "work.created" && payload.work) map.set(payload.work.id, payload.work as WorkItem);
      const work = payload.id ? map.get(payload.id) : undefined;
      if (!work) continue;
      if (event.type === "work.started") work.status = "running";
      if (event.type === "work.updated") work.status = payload.status;
      if (event.type === "work.completed") work.status = "succeeded";
      if (event.type === "work.failed") work.status = "failed";
      if (event.type === "work.blocked") work.status = "blocked";
      if (event.type === "work.invalidated") work.status = "invalidated";
    }
    return [...map.values()];
  }

  private async listOpenGaps(missionId: string): Promise<Gap[]> {
    if (this.projections) return (await this.projections.listGaps(missionId)).filter(gap => gap.status === "open" || gap.status === "working" || gap.status === "blocked");
    const map = new Map<string, Gap>();
    for (const event of await this.store.list(missionId)) {
      const payload = event.payload as any;
      if (event.type === "gap.opened") {
        map.set(payload.id, {
          id: payload.id,
          missionId,
          category: payload.category ?? "quality",
          severity: payload.severity,
          description: payload.description ?? "Unspecified mission gap",
          findingRefs: payload.findingRefs ?? [],
          requirementRefs: payload.requirementRefs ?? [],
          artifactRefs: payload.artifactRefs ?? [],
          status: "open",
          openedAt: event.createdAt
        });
      }
      if ((event.type === "gap.resolved" || event.type === "gap.accepted") && map.has(payload.id)) {
        map.get(payload.id)!.status = event.type === "gap.resolved" ? "resolved" : "accepted";
      }
    }
    return [...map.values()].filter(gap => gap.status === "open" || gap.status === "working" || gap.status === "blocked");
  }

  private decisionForDiagnosis(missionId: string, gap: Gap, diagnosis: { intervention: "retry" | "revise_work" | "replace_capability" | "replan_local" | "revise_strategy"; rootCause: string; confidence: number }): MissionDecision {
    const type: MissionDecision["type"] = diagnosis.intervention === "replace_capability" ? "replace_capability"
      : diagnosis.intervention === "replan_local" ? "replan_local"
      : diagnosis.intervention === "revise_strategy" ? "revise_strategy"
      : diagnosis.intervention === "retry" ? "retry"
      : "revise_work";
    return {
      id: randomUUID(),
      missionId,
      type,
      targetRefs: [gap.id],
      rationale: diagnosis.rootCause,
      evidenceRefs: [],
      gapRefs: [gap.id],
      requirementRefs: [...gap.requirementRefs],
      expectedImpact: `Resolve ${gap.severity} gap ${gap.id}`,
      confidence: diagnosis.confidence,
      requiresApproval: false,
      status: "proposed",
      createdAt: new Date().toISOString()
    };
  }

  private repairWorkItem(state: MissionState, gap: Gap, rootCause: string): WorkItem {
    const now = new Date().toISOString();
    return {
      id: `repair-${gap.id}`,
      missionId: state.missionId,
      purpose: "repair",
      objective: `Resolve gap: ${gap.description}. Diagnosed cause: ${rootCause}`,
      status: "ready",
      requirementRefs: [...gap.requirementRefs],
      gapRefs: [gap.id],
      inputArtifactRefs: [...gap.artifactRefs],
      expectedOutputs: [],
      localAcceptanceCriteria: [{ id: `resolve-${gap.id}`, description: `Gap ${gap.id} is resolved and independently verified`, priority: "required" }],
      capabilityNeedRefs: [],
      priority: gap.severity === "critical" ? 100 : gap.severity === "major" ? 80 : 50,
      graphRevision: state.graphRevision,
      createdBy: "replanner",
      createdAt: now,
      updatedAt: now
    };
  }

  private async materializeCompletionObjections(missionId: string, state: MissionState, challenge: CompletionChallenge): Promise<void> {
    for (let index = 0; index < challenge.objections.length; index++) {
      const objection = challenge.objections[index]!;
      if (objection.severity !== "blocking") continue;
      await this.openGap(missionId, {
        id: `completion-${state.revision}-${index + 1}`,
        severity: "major",
        description: objection.description,
        blocking: true,
        category: "evidence",
        requirementRefs: objection.requirementRefs,
        artifactRefs: objection.artifactRefs
      });
    }
  }
}
