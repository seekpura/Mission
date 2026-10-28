import { randomUUID } from "node:crypto";
import type { EventStore } from "../events/event-store.ts";
import { projectMissionState } from "../events/state-projector.ts";
import type { MissionEventType } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { MissionDecision } from "../domain/decision.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";
import type {
  CompletionChallenge,
  DeliberationProvider,
  GapDiagnosis,
  StrategyProposal
} from "../planning/deliberation-provider.ts";
import {
  hasNonTerminalWorkForGap,
  openGaps,
  projectMissionJournal,
  terminalWorkCountForGap,
  type MissionJournalView
} from "./journal-view.ts";

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

interface CycleView {
  state: MissionState;
  journal: MissionJournalView;
}

export class MissionController {
  private readonly store: EventStore;
  private readonly deliberation?: DeliberationProvider;

  constructor(store: EventStore, deliberation?: DeliberationProvider) {
    this.store = store;
    this.deliberation = deliberation;
  }

  async emit(
    missionId: string,
    type: MissionEventType,
    payload: unknown,
    actor: { type: "user" | "controller" | "planner" | "worker" | "verifier" | "host" | "system"; id?: string } = { type: "controller" },
    idempotencyKey?: string
  ) {
    const expected = await this.store.lastSequence(missionId);
    return this.store.append({
      id: randomUUID(),
      missionId,
      type,
      actor,
      payload,
      idempotencyKey,
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    }, expected);
  }

  async createMission(missionId: string, userGoal: string) {
    if (await this.store.lastSequence(missionId) > 0) return this.state(missionId);
    await this.emit(missionId, "mission.created", { missionId, userGoal }, { type: "user" }, `mission-created:${missionId}`);
    await this.emit(missionId, "mission.spec.revised", { revision: 1, objective: userGoal });
    await this.emit(missionId, "acceptance.created", { revision: 1 });
    return this.state(missionId);
  }

  async proposeWork(work: WorkItem) {
    const hasReason = work.purpose === "exploration" || work.requirementRefs.length > 0 || work.gapRefs.length > 0 || work.inputArtifactRefs.length > 0 || work.capabilityNeedRefs.length > 0;
    if (!hasReason) throw new Error(`Orphan work item rejected: ${work.id}`);
    await this.emit(
      work.missionId,
      "work.created",
      { id: work.id, status: work.status, workstreamId: work.workstreamId, work },
      { type: "planner" },
      `work-created:${work.id}`
    );
  }

  async steer(missionId: string, message: string) {
    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });
    return this.state(missionId);
  }

  async openGap(missionId: string, payload: {
    id: string;
    severity: "critical" | "major" | "minor";
    description: string;
    blocking?: boolean;
    category?: Gap["category"];
    findingRefs?: string[];
    requirementRefs?: string[];
    artifactRefs?: string[];
  }) {
    const now = new Date().toISOString();
    await this.emit(missionId, "gap.opened", {
      id: payload.id,
      missionId,
      category: payload.category ?? "quality",
      severity: payload.severity,
      description: payload.description,
      findingRefs: [...(payload.findingRefs ?? [])],
      requirementRefs: [...(payload.requirementRefs ?? [])],
      artifactRefs: [...(payload.artifactRefs ?? [])],
      status: "open",
      openedAt: now,
      ...(payload.blocking === undefined ? {} : { blocking: payload.blocking })
    }, { type: "verifier" }, `gap:${payload.id}`);
  }

  async resolveGap(missionId: string, gapId: string) {
    await this.emit(missionId, "gap.resolved", { id: gapId }, { type: "verifier" }, `gap-resolved:${gapId}`);
  }

  async validateArtifact(missionId: string, artifactRef: string, final = false) {
    await this.emit(missionId, "artifact.validated", { artifactRef, final }, { type: "verifier" }, `artifact-validated:${artifactRef}:${final}`);
  }

  async completeIfEligible(missionId: string): Promise<MissionState> {
    const state = await this.state(missionId);
    if (!completionGateEligible(state)) return state;
    await this.emit(missionId, "mission.completed", { reason: "deterministic completion gate passed" }, { type: "controller" }, `mission-completed:${state.revision}`);
    return this.state(missionId);
  }

  async runControllerCycle(input: ControllerCycleInput): Promise<ControllerCycleResult> {
    const decisionsCreated: string[] = [];
    const workItemsCreated: string[] = [];

    if (!this.deliberation) {
      const after = await this.completeIfEligible(input.missionId);
      return result(after, decisionsCreated, workItemsCreated);
    }

    let view = await this.cycleView(input.missionId);
    if (view.state.status === "completed") return result(view.state, decisionsCreated, workItemsCreated);

    if (view.state.strategyRevision === null) {
      const proposal = await this.deliberation.composeStrategy({
        state: view.state,
        userGoal: view.journal.userGoal
      });
      await this.persistStrategy(input.missionId, view.state, proposal, "created");
      view = await this.cycleView(input.missionId);
    }

    const gapsBeforePlanning = openGaps(view.journal);
    for (const gap of gapsBeforePlanning) {
      if (hasNonTerminalWorkForGap(view.journal, gap.id)) continue;

      const diagnosisOrdinal = terminalWorkCountForGap(view.journal, gap.id);
      const decisionId = `gap-diagnosis:${gap.id}:${diagnosisOrdinal}`;
      if (view.journal.decisionIds.has(decisionId)) continue;

      const diagnosis = await this.deliberation.diagnoseGap({ state: view.state, gap });
      await this.emitGapDecision(input.missionId, decisionId, gap, diagnosis);
      decisionsCreated.push(decisionId);

      if (diagnosis.intervention === "revise_strategy") {
        const proposal = await this.deliberation.composeStrategy({
          state: await this.state(input.missionId),
          userGoal: view.journal.userGoal
        });
        const current = await this.state(input.missionId);
        await this.persistStrategy(input.missionId, current, proposal, "revised", decisionId);
      }

      await this.emit(
        input.missionId,
        "decision.applied",
        { id: decisionId },
        { type: "controller" },
        `decision-applied:${decisionId}`
      );
      view = await this.cycleView(input.missionId);
    }

    if (shouldPlanFrontier(view.state)) {
      const proposal = await this.deliberation.planFrontier({
        state: view.state,
        openGaps: openGaps(view.journal)
      });
      const admitted = admitFrontier(input.missionId, view, proposal.workItems);
      if (admitted.length > 0) {
        const graphRevision = Math.max(view.state.graphRevision + 1, proposal.graphRevision);
        await this.emit(
          input.missionId,
          "graph.revised",
          { revision: graphRevision, workItemIds: admitted.map(work => work.id) },
          { type: "planner" },
          `graph-revised:${graphRevision}`
        );
        for (const candidate of admitted) {
          const work = { ...candidate, graphRevision, status: "ready" as const };
          await this.proposeWork(work);
          workItemsCreated.push(work.id);
        }
        view = await this.cycleView(input.missionId);
      }
    }

    if (completionGateEligible(view.state)) {
      const challenge = await this.deliberation.challengeCompletion({ state: view.state });
      const challengeRevision = view.state.revision;
      const decisionId = `completion-challenge:${challengeRevision}`;
      const blocked = challengeBlocks(challenge);

      if (!view.journal.decisionIds.has(decisionId)) {
        const decision: MissionDecision = {
          id: decisionId,
          missionId: input.missionId,
          type: blocked ? "block" : "complete",
          targetRefs: [...view.state.finalArtifactRefs],
          rationale: completionRationale(challenge),
          evidenceRefs: [],
          gapRefs: [],
          requirementRefs: unique(challenge.objections.flatMap(objection => objection.requirementRefs)),
          expectedImpact: blocked ? "Prevent premature mission completion" : "Permit runtime-enforced mission completion",
          confidence: challenge.confidence,
          requiresApproval: false,
          status: "proposed",
          createdAt: new Date().toISOString()
        };
        await this.emit(
          input.missionId,
          "decision.created",
          decision,
          { type: "verifier" },
          `decision-created:${decisionId}`
        );
        decisionsCreated.push(decisionId);
      }

      if (blocked) {
        const blockingObjections = challenge.objections.filter(objection => objection.severity === "blocking");
        const objections = blockingObjections.length > 0
          ? blockingObjections
          : [{
              description: "Completion challenger reported a blocking objection without a blocking detail.",
              requirementRefs: [] as string[],
              artifactRefs: [...view.state.finalArtifactRefs],
              severity: "blocking" as const
            }];

        for (const [index, objection] of objections.entries()) {
          await this.openGap(input.missionId, {
            id: `completion-objection:${challengeRevision}:${index}`,
            severity: "major",
            description: objection.description,
            blocking: true,
            category: "quality",
            requirementRefs: objection.requirementRefs,
            artifactRefs: objection.artifactRefs
          });
        }
        await this.emit(
          input.missionId,
          "decision.applied",
          { id: decisionId },
          { type: "controller" },
          `decision-applied:${decisionId}`
        );
        view = await this.cycleView(input.missionId);
        return result(view.state, decisionsCreated, workItemsCreated);
      }

      await this.emit(
        input.missionId,
        "decision.applied",
        { id: decisionId },
        { type: "controller" },
        `decision-applied:${decisionId}`
      );
      const completed = await this.completeIfEligible(input.missionId);
      return result(completed, decisionsCreated, workItemsCreated);
    }

    view = await this.cycleView(input.missionId);
    return result(view.state, decisionsCreated, workItemsCreated);
  }

  async state(missionId: string) {
    return projectMissionState(missionId, await this.store.list(missionId));
  }

  private async cycleView(missionId: string): Promise<CycleView> {
    const events = await this.store.list(missionId);
    return {
      state: projectMissionState(missionId, events),
      journal: projectMissionJournal(missionId, events)
    };
  }

  private async persistStrategy(
    missionId: string,
    state: MissionState,
    proposal: StrategyProposal,
    mode: "created" | "revised",
    causeRef?: string
  ): Promise<void> {
    const revision = mode === "created"
      ? Math.max(1, proposal.revision)
      : Math.max((state.strategyRevision ?? 0) + 1, proposal.revision);
    await this.emit(
      missionId,
      mode === "created" ? "strategy.created" : "strategy.revised",
      { ...proposal, revision, ...(causeRef ? { causeRef } : {}) },
      { type: "planner" },
      `${mode === "created" ? "strategy-created" : "strategy-revised"}:${missionId}:${revision}:${causeRef ?? "initial"}`
    );
  }

  private async emitGapDecision(
    missionId: string,
    decisionId: string,
    gap: Gap,
    diagnosis: GapDiagnosis
  ): Promise<void> {
    const decision: MissionDecision = {
      id: decisionId,
      missionId,
      type: diagnosis.intervention,
      targetRefs: [gap.id, ...gap.artifactRefs],
      rationale: diagnosis.rootCause,
      evidenceRefs: [],
      gapRefs: [gap.id],
      requirementRefs: [...gap.requirementRefs],
      expectedImpact: `Resolve or reduce gap ${gap.id}`,
      confidence: diagnosis.confidence,
      requiresApproval: false,
      status: "proposed",
      createdAt: new Date().toISOString()
    };
    await this.emit(
      missionId,
      "decision.created",
      decision,
      { type: "planner" },
      `decision-created:${decisionId}`
    );
  }
}

function completionGateEligible(state: MissionState): boolean {
  if (state.status === "completed") return false;
  if (state.blockingGapIds.length > 0) return false;
  if (state.readyWorkItemIds.length > 0 || state.activeWorkItemIds.length > 0) return false;
  if (state.blockedWorkItemIds.length > 0 || state.verifyingWorkItemIds.length > 0) return false;
  if (state.activeExecutionIds.length > 0 || state.pendingApprovalIds.length > 0) return false;
  return state.finalArtifactRefs.length > 0;
}

function shouldPlanFrontier(state: MissionState): boolean {
  if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") return false;
  if (state.pendingApprovalIds.length > 0 || state.activeExecutionIds.length > 0) return false;
  if (state.readyWorkItemIds.length > 0 || state.activeWorkItemIds.length > 0 || state.verifyingWorkItemIds.length > 0) return false;
  return !completionGateEligible(state);
}

function admitFrontier(missionId: string, view: CycleView, proposed: WorkItem[]): WorkItem[] {
  const admitted: WorkItem[] = [];
  const seen = new Set<string>();
  for (const work of proposed) {
    if (work.missionId !== missionId) throw new Error(`Planner proposed work for wrong mission: ${work.id}`);
    if (seen.has(work.id) || view.journal.workItems.has(work.id)) continue;
    if (work.status !== "ready" && work.status !== "proposed") {
      throw new Error(`Planner frontier work must be proposed or ready: ${work.id} (${work.status})`);
    }
    const hasReason = work.purpose === "exploration" || work.requirementRefs.length > 0 || work.gapRefs.length > 0 || work.inputArtifactRefs.length > 0 || work.capabilityNeedRefs.length > 0;
    if (!hasReason) throw new Error(`Planner proposed orphan work item: ${work.id}`);
    seen.add(work.id);
    admitted.push(work);
  }
  return admitted;
}

function challengeBlocks(challenge: CompletionChallenge): boolean {
  return challenge.blockingObjection || challenge.objections.some(objection => objection.severity === "blocking");
}

function completionRationale(challenge: CompletionChallenge): string {
  if (challenge.objections.length === 0) return "Independent completion challenge found no remaining objections.";
  return challenge.objections.map(objection => objection.description).join(" | ");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function result(
  state: MissionState,
  decisionsCreated: string[],
  workItemsCreated: string[]
): ControllerCycleResult {
  return {
    missionRevision: state.revision,
    decisionsCreated,
    workItemsCreated,
    executionsDispatched: [],
    verificationsScheduled: [],
    status: state.status
  };
}
