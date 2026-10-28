import { randomUUID } from "node:crypto";
import type { EventStore } from "../events/event-store.ts";
import { OptimisticConcurrencyError } from "../events/event-store.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";
import { projectMissionState } from "../events/state-projector.ts";
import type { MissionEvent, MissionEventType } from "../domain/event.ts";
import type { AcceptanceContract, MissionSpec, MissionState, Requirement } from "../domain/mission.ts";
import type { MissionDecision } from "../domain/decision.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Evidence, Gap, VerificationResult } from "../domain/verification.ts";
import type { Artifact } from "../domain/artifact.ts";
import { AcceptanceEvaluator, type AcceptanceEvaluation } from "../acceptance/acceptance-evaluator.ts";
import { MissionReadModel } from "./mission-read-model.ts";
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
  private readonly readModel: MissionReadModel;

  constructor(store: EventStore, dependencies: MissionControllerDependencies = {}) {
    this.store = store;
    this.projections = dependencies.projections;
    this.deliberation = dependencies.deliberation;
    this.concurrencyRetries = dependencies.concurrencyRetries ?? 5;
    this.readModel = new MissionReadModel(store, dependencies.projections);
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
    const state = await this.state(missionId);
    if (this.deliberation?.interpretMission) {
      const interpretation = await this.deliberation.interpretMission({ missionId, userGoal, state });
      await this.emit(missionId, "mission.spec.revised", { revision: interpretation.missionSpec.revision, spec: interpretation.missionSpec, objective: interpretation.missionSpec.objective }, { type: "controller" }, `mission-spec:${missionId}:${interpretation.missionSpec.revision}`);
      await this.emit(missionId, "acceptance.created", { revision: interpretation.acceptanceContract.revision, contract: interpretation.acceptanceContract }, { type: "controller" }, `acceptance:${missionId}:${interpretation.acceptanceContract.revision}`);
    } else {
      const now = new Date().toISOString();
      const spec: MissionSpec = { missionId, revision: 1, objective: userGoal, requestedOutputs: [], constraints: [], preferences: [], sourceRefs: [], createdAt: now };
      const contract: AcceptanceContract = { missionId, revision: 1, requirements: [], requiredArtifacts: [], requiredValidations: [], criticalFailureConditions: [], createdAt: now };
      await this.emit(missionId, "mission.spec.revised", { revision: 1, spec, objective: userGoal }, { type: "controller" }, `mission-spec:${missionId}:1`);
      await this.emit(missionId, "acceptance.created", { revision: 1, contract }, { type: "controller" }, `acceptance:${missionId}:1`);
    }
    return this.state(missionId);
  }

  async proposeWork(work: WorkItem) {
    const hasReason = work.purpose === "exploration" || work.requirementRefs.length > 0 || work.gapRefs.length > 0 || work.inputArtifactRefs.length > 0 || work.capabilityNeedRefs.length > 0;
    if (!hasReason) throw new Error(`Orphan work item rejected: ${work.id}`);
    await this.emit(work.missionId, "work.created", { id: work.id, status: work.status, workstreamId: work.workstreamId, work }, { type: work.createdBy === "verifier" ? "verifier" : "planner" }, `work-created:${work.id}`);
  }

  async recordArtifact(missionId: string, artifact: Artifact, actorType: "worker" | "verifier" = "worker"): Promise<void> {
    await this.emit(missionId, "artifact.created", { artifact }, { type: actorType }, `artifact-created:${artifact.id}:${artifact.version}`);
  }

  async recordVerification(missionId: string, verification: VerificationResult): Promise<void> {
    await this.emit(missionId, "verification.completed", { verification }, { type: "verifier" }, `verification:${verification.id}`);
  }

  async recordEvidence(missionId: string, evidence: Evidence): Promise<void> {
    await this.emit(missionId, "evidence.created", { evidence }, { type: "verifier" }, `evidence:${evidence.id}`);
  }

  async setRequirementStatus(missionId: string, requirementId: string, status: Requirement["status"], evidenceRefs: string[] = []): Promise<void> {
    await this.emit(missionId, "requirement.status.changed", { id: requirementId, status, evidenceRefs }, { type: "verifier" }, `requirement:${requirementId}:${status}:${[...evidenceRefs].sort().join(",")}`);
  }

  async acceptanceEvaluation(missionId: string): Promise<AcceptanceEvaluation> {
    const [contract, requirements, artifacts, evidence, verifications] = await Promise.all([
      this.readModel.acceptanceContract(missionId),
      this.readModel.requirements(missionId),
      this.readModel.artifacts(missionId),
      this.readModel.evidence(missionId),
      this.readModel.verifications(missionId)
    ]);
    return new AcceptanceEvaluator().evaluate({ contract, requirements, artifacts, evidence, verifications });
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
    if (!this.passesOperationalCompletionGate(state)) return state;
    const acceptance = await this.acceptanceEvaluation(missionId);
    if (!acceptance.satisfied) return state;

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
      const proposal = await this.deliberation.composeStrategy({ state, userGoal: await this.readModel.userGoal(input.missionId), acceptanceContract: await this.readModel.acceptanceContract(input.missionId) });
      await this.emit(input.missionId, "strategy.created", proposal, { type: "planner" }, `strategy:${input.missionId}:${proposal.revision}`);
      state = await this.state(input.missionId);
    }

    const openGaps = await this.readModel.openGaps(input.missionId);
    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));
    if (this.deliberation && blockingGap) {
      const existingRepair = (await this.readModel.workItems(input.missionId)).find(work =>
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
      const frontier = await this.deliberation.planFrontier({
        state,
        userGoal: await this.readModel.userGoal(input.missionId),
        openGaps,
        acceptanceContract: await this.readModel.acceptanceContract(input.missionId),
        requirements: await this.readModel.requirements(input.missionId)
      });
      if (frontier.graphRevision > state.graphRevision) {
        await this.emit(input.missionId, "graph.revised", { revision: frontier.graphRevision }, { type: "planner" }, `graph:${input.missionId}:${frontier.graphRevision}`);
      }
      for (const need of frontier.capabilityNeeds ?? []) {
        await this.emit(input.missionId, "capability.need.created", { need }, { type: "planner" }, `capability-need:${need.id}`);
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

  private passesOperationalCompletionGate(state: MissionState): boolean {
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

  private decisionForDiagnosis(missionId: string, gap: Gap, diagnosis: { intervention: "retry" | "revise_work" | "replace_capability" | "replan_local" | "revise_strategy"; rootCause: string; confidence: number }): MissionDecision {
    const type: MissionDecision["type"] = diagnosis.intervention === "replace_capability" ? "replace_capability"
      : diagnosis.intervention === "replan_local" ? "replan_graph"
      : diagnosis.intervention === "revise_strategy" ? "revise_strategy"
      : diagnosis.intervention === "retry" ? "retry" : "revise_work";
    return {
      id: `decision-${gap.id}-${randomUUID().slice(0, 8)}`,
      missionId,
      type,
      targetRef: gap.id,
      rationale: diagnosis.rootCause,
      evidenceRefs: gap.findingRefs,
      expectedImpact: `Resolve gap ${gap.id}`,
      confidence: diagnosis.confidence,
      urgency: gap.severity === "critical" ? "critical" : "high",
      reversible: true,
      requiresApproval: false,
      status: "active",
      createdAt: new Date().toISOString()
    };
  }

  private repairWorkItem(state: MissionState, gap: Gap, rootCause: string): WorkItem {
    const now = new Date().toISOString();
    return {
      id: `repair-${gap.id}-${state.graphRevision + 1}`,
      missionId: state.missionId,
      purpose: "repair",
      objective: `Resolve ${gap.description}. Root cause: ${rootCause}`,
      status: "ready",
      requirementRefs: gap.requirementRefs,
      gapRefs: [gap.id],
      inputArtifactRefs: gap.artifactRefs,
      expectedOutputs: [],
      localAcceptanceCriteria: [{ id: `repair-${gap.id}`, description: `Gap ${gap.id} is resolved and verified`, priority: "required" }],
      capabilityNeedRefs: [],
      priority: gap.severity === "critical" ? 100 : gap.severity === "major" ? 90 : 60,
      graphRevision: state.graphRevision + 1,
      createdBy: "replanner",
      createdAt: now,
      updatedAt: now
    };
  }

  private async materializeCompletionObjections(missionId: string, state: MissionState, challenge: CompletionChallenge) {
    let index = 0;
    for (const objection of challenge.objections.filter(item => item.severity === "blocking")) {
      const id = `completion-objection-${state.revision}-${++index}`;
      await this.openGap(missionId, {
        id,
        severity: "critical",
        description: objection.description,
        category: "evidence",
        requirementRefs: objection.requirementRefs,
        artifactRefs: objection.artifactRefs,
        blocking: true
      });
    }
    if (challenge.blockingObjection && index === 0) {
      await this.openGap(missionId, {
        id: `completion-objection-${state.revision}-generic`,
        severity: "critical",
        description: "Completion challenger reported a blocking objection without structured details",
        category: "evidence",
        blocking: true
      });
    }
  }
}
