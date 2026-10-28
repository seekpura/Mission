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
import type { DeliberationProvider, CompletionChallenge, GapDiagnosis } from "../planning/deliberation-provider.ts";
import type { SteeringApplicationResult, SteeringInterpretation } from "../domain/steering.ts";
import { SteeringImpactAnalyzer } from "../steering/steering-impact-analyzer.ts";
import { MissionProgressTracker } from "../progress/progress-tracker.ts";
import { BudgetTracker } from "../budget/budget-tracker.ts";
import type { BudgetAssessment, CostEvent, MissionBudget } from "../domain/budget.ts";
import { normalizeGapDiagnosis } from "../planning/repair-scope-policy.ts";
import { RepairEnactmentPolicy } from "../planning/repair-enactment-policy.ts";

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
  private readonly repairEnactment = new RepairEnactmentPolicy();
  private readonly steeringImpact = new SteeringImpactAnalyzer();
  private readonly progressTracker: MissionProgressTracker;
  private readonly budgetTracker: BudgetTracker;

  constructor(store: EventStore, dependencies: MissionControllerDependencies = {}) {
    this.store = store;
    this.projections = dependencies.projections;
    this.deliberation = dependencies.deliberation;
    this.concurrencyRetries = dependencies.concurrencyRetries ?? 5;
    this.readModel = new MissionReadModel(store, dependencies.projections);
    this.progressTracker = new MissionProgressTracker(store, this.readModel);
    this.budgetTracker = new BudgetTracker(store, this.readModel);
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

  async recordArtifact(missionId: string, artifact: Artifact): Promise<void> {
    await this.emit(missionId, "artifact.created", { artifact }, { type: "worker" }, `artifact-created:${artifact.id}:${artifact.version}`);
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

  async configureBudget(missionId: string, budget: MissionBudget): Promise<BudgetAssessment> {
    validateBudget(budget);
    await this.emit(missionId, "budget.configured", { budget }, { type: "user" }, `budget-configured:${missionId}:${budgetFingerprint(budget)}`);
    const state = await this.state(missionId);
    const assessment = await this.budgetTracker.assess(missionId, state);
    if (state.status === "budget_exhausted" && !assessment.exhausted) {
      await this.emit(missionId, "mission.status.changed", { status: "active", reason: "Budget increased or reset" }, { type: "user" }, `budget-resumed:${state.revision}`);
    }
    return this.budgetTracker.assess(missionId, await this.state(missionId));
  }

  async recordCost(missionId: string, cost: CostEvent): Promise<void> {
    if (cost.missionId !== missionId) throw new Error("Cost event mission mismatch");
    validateUsage(cost.usage);
    await this.emit(missionId, "cost.recorded", { cost }, { type: "system" }, `cost:${cost.id}`);
  }

  async budgetAssessment(missionId: string): Promise<BudgetAssessment> {
    return this.budgetTracker.assess(missionId, await this.state(missionId));
  }

  async steer(missionId: string, message: string) {
    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });
    return this.state(missionId);
  }

  async steerWithImpact(missionId: string, message: string): Promise<SteeringApplicationResult> {
    const before = await this.state(missionId);
    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });
    const [missionSpec, acceptanceContract, workItems, artifacts] = await Promise.all([
      this.readModel.missionSpec(missionId), this.readModel.acceptanceContract(missionId),
      this.readModel.workItems(missionId), this.readModel.artifacts(missionId)
    ]);
    if (!this.deliberation?.interpretSteering) {
      return { impact: {
        kind: "operational", reason: "No steering interpreter configured; preserved current mission semantics", confidence: 1,
        previousMissionRevision: before.revision, strategyImpact: "none", affectedRequirementRefs: [],
        invalidatedWorkItemRefs: [], invalidatedArtifactRefs: [],
        unaffectedActiveWorkItemRefs: workItems.filter(work => ["ready", "running", "waiting", "verifying", "blocked"].includes(work.status)).map(work => work.id)
      } };
    }
    const interpretation = await this.deliberation.interpretSteering({ missionId, message, state: await this.state(missionId), missionSpec, acceptanceContract, workItems, artifacts });
    if (interpretation.kind === "operational") {
      return { impact: this.steeringImpact.analyze({ missionRevision: before.revision, interpretation, workItems, artifacts }) };
    }

    const now = new Date().toISOString();
    let revisedSpec = missionSpec ?? undefined;
    if (interpretation.specPatch && missionSpec) {
      revisedSpec = { ...missionSpec, ...definedPatch(interpretation.specPatch), revision: missionSpec.revision + 1, createdAt: now };
      await this.emit(missionId, "mission.spec.revised", { revision: revisedSpec.revision, spec: revisedSpec, objective: revisedSpec.objective }, { type: "controller" }, `mission-spec:${missionId}:${revisedSpec.revision}`);
    }

    let revisedContract: AcceptanceContract | undefined;
    let changedRequirementRefs: string[] = [];
    if (interpretation.revisedAcceptanceContract) {
      const previous = acceptanceContract;
      const revision = (previous?.revision ?? 0) + 1;
      changedRequirementRefs = acceptanceChangedRequirements(previous, interpretation.revisedAcceptanceContract);
      const previousRequirements = new Map((previous?.requirements ?? []).map(requirement => [requirement.id, requirement]));
      const affected = new Set([...interpretation.affectedRequirementRefs, ...changedRequirementRefs]);
      revisedContract = {
        ...interpretation.revisedAcceptanceContract, missionId, revision, createdAt: now,
        requirements: interpretation.revisedAcceptanceContract.requirements.map(requirement => {
          const old = previousRequirements.get(requirement.id);
          const canPreserve = old && !affected.has(requirement.id) && sameRequirementMeaning(old, requirement);
          return canPreserve ? { ...requirement, status: old.status, evidenceRefs: [...old.evidenceRefs] } : { ...requirement, status: "unverified", evidenceRefs: [] };
        })
      };
      await this.emit(missionId, "acceptance.revised", { revision, contract: revisedContract }, { type: "controller" }, `acceptance:${missionId}:${revision}`);
    }

    const impact = this.steeringImpact.analyze({ missionRevision: before.revision, interpretation, workItems, artifacts, changedRequirementRefs });
    impact.missionSpecRevision = revisedSpec?.revision;
    impact.acceptanceRevision = revisedContract?.revision;
    for (const workId of impact.invalidatedWorkItemRefs) {
      await this.emit(missionId, "work.invalidated", { id: workId, reason: `User steering: ${interpretation.reason}` }, { type: "controller" }, `steering-work-invalidated:${before.revision}:${workId}`);
    }
    for (const artifactRef of impact.invalidatedArtifactRefs) {
      await this.emit(missionId, "artifact.invalidated", { artifactRef, reason: `User steering: ${interpretation.reason}` }, { type: "controller" }, `steering-artifact-invalidated:${before.revision}:${artifactRef}`);
    }
    if (before.status === "completed" && (impact.invalidatedWorkItemRefs.length || impact.invalidatedArtifactRefs.length || revisedContract || revisedSpec)) {
      await this.emit(missionId, "mission.reopened", { reason: interpretation.reason }, { type: "controller" }, `mission-reopened:steering:${before.revision}`);
    }
    if (interpretation.strategyImpact === "global" && this.deliberation) {
      const state = await this.state(missionId);
      const proposal = await this.deliberation.composeStrategy({ state, userGoal: revisedSpec?.objective ?? await this.readModel.userGoal(missionId), acceptanceContract: revisedContract ?? acceptanceContract });
      const revision = Math.max((state.strategyRevision ?? 0) + 1, proposal.revision);
      await this.emit(missionId, "strategy.revised", { ...proposal, revision, reason: interpretation.reason }, { type: "planner" }, `strategy:${missionId}:${revision}`);
    }
    return { impact, missionSpec: revisedSpec, acceptanceContract: revisedContract };
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

    if (state.status !== "completed") {
      const budget = await this.budgetTracker.assess(input.missionId, state);
      if (budget.exhausted) {
        const completion = await this.completeIfEligible(input.missionId);
        if (completion.status === "completed") {
          return { missionRevision: completion.revision, decisionsCreated, workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: completion.status };
        }
        await this.emit(input.missionId, "budget.exhausted", { assessment: budget }, { type: "controller" }, `budget-exhausted:${budgetFingerprint(budget.budget ?? {})}:${budget.usage.attempts}:${budget.usage.totalTokens}:${budget.usage.capabilityAcquisitions}`);
        await this.emit(input.missionId, "mission.status.changed", { status: "budget_exhausted", reason: budget.reasons.join("; ") }, { type: "controller" }, `mission-budget-exhausted:${state.revision}`);
        state = await this.state(input.missionId);
        return { missionRevision: state.revision, decisionsCreated, workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: state.status };
      }
    }

    if (this.deliberation && state.strategyRevision === null) {
      const proposal = await this.deliberation.composeStrategy({ state, userGoal: await this.readModel.userGoal(input.missionId), acceptanceContract: await this.readModel.acceptanceContract(input.missionId) });
      await this.emit(input.missionId, "strategy.created", proposal, { type: "planner" }, `strategy:${input.missionId}:${proposal.revision}`);
      state = await this.state(input.missionId);
    }

    const openGaps = await this.readModel.openGaps(input.missionId);
    const blockingGap = openGaps.find(gap => gap.status === "open" && (gap.severity === "critical" || gap.severity === "major"));
    let plateauAssessment: import("../domain/progress.ts").PlateauAssessment | undefined;
    if (blockingGap) {
      const snapshot = await this.progressTracker.snapshot(input.missionId, state);
      plateauAssessment = await this.progressTracker.assess(input.missionId, state, snapshot);
      await this.emit(input.missionId, "progress.observed", { snapshot, assessment: plateauAssessment }, { type: "controller" }, `progress:${input.missionId}:${state.revision}`);
      state = await this.state(input.missionId);
      if (plateauAssessment.state === "plateau") {
        const decision: MissionDecision = {
          id: randomUUID(), missionId: input.missionId, type: "block", targetRefs: [blockingGap.id],
          rationale: plateauAssessment.reason, evidenceRefs: [], gapRefs: [blockingGap.id], requirementRefs: [...blockingGap.requirementRefs],
          expectedImpact: "Stop unproductive repair churn and report truthful plateau", confidence: 1, requiresApproval: false, status: "applied", createdAt: new Date().toISOString()
        };
        await this.emit(input.missionId, "decision.created", { decision }, { type: "controller" }, `plateau-decision:${blockingGap.id}:${state.revision}`);
        await this.emit(input.missionId, "mission.status.changed", { status: "plateau", reason: plateauAssessment.reason, gapId: blockingGap.id }, { type: "controller" }, `mission-plateau:${blockingGap.id}:${state.revision}`);
        const plateauState = await this.state(input.missionId);
        return { missionRevision: plateauState.revision, decisionsCreated: [decision.id], workItemsCreated, executionsDispatched: [], verificationsScheduled: [], status: plateauState.status };
      }
    }
    if (this.deliberation && blockingGap) {
      const allWorkItems = await this.readModel.workItems(input.missionId);
      const relatedWorkItems = allWorkItems.filter(work => work.gapRefs.includes(blockingGap.id));
      const existingRepair = relatedWorkItems.find(work =>
        work.purpose === "repair" && !["succeeded", "failed", "invalidated", "superseded", "abandoned"].includes(work.status)
      );
      if (!existingRepair) {
        const findingIds = new Set(blockingGap.findingRefs);
        const findings = (await this.readModel.findings(input.missionId)).filter(finding => findingIds.has(finding.id));
        const evidenceIds = new Set(findings.flatMap(finding => finding.evidenceRefs));
        const evidence = (await this.readModel.evidence(input.missionId)).filter(item => evidenceIds.has(item.id));
        const priorRepairCount = relatedWorkItems.filter(work => work.purpose === "repair").length;
        const rawDiagnosis = await this.deliberation.diagnoseGap({
          state,
          gap: blockingGap,
          findings,
          evidence,
          relatedWorkItems,
          priorRepairCount,
          plateauContext: plateauAssessment?.context
        });
        const diagnosis = normalizeGapDiagnosis(rawDiagnosis, {
          findingRefs: findings.map(finding => finding.id),
          evidenceRefs: evidence.map(item => item.id),
          priorRepairCount
        });
        const decision = this.decisionForDiagnosis(input.missionId, blockingGap, diagnosis);
        await this.emit(input.missionId, "decision.created", { decision, diagnosis }, { type: "controller" }, `decision:${blockingGap.id}:${diagnosis.intervention}:${priorRepairCount + 1}`);
        decisionsCreated.push(decision.id);

        if (diagnosis.intervention === "replan_local" || diagnosis.intervention === "revise_strategy") {
          if (diagnosis.intervention === "revise_strategy") {
            const proposal = await this.deliberation.composeStrategy({
              state,
              userGoal: await this.readModel.userGoal(input.missionId),
              acceptanceContract: await this.readModel.acceptanceContract(input.missionId)
            });
            const revision = Math.max((state.strategyRevision ?? 0) + 1, proposal.revision);
            await this.emit(input.missionId, "strategy.revised", { ...proposal, revision }, { type: "planner" }, `strategy:${input.missionId}:${revision}`);
            state = await this.state(input.missionId);
          }
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
        } else {
          const relatedWorkIds = new Set(relatedWorkItems.map(work => work.id));
          const [invocationReceipts, capabilityNeeds] = await Promise.all([
            this.readModel.invocationReceipts(input.missionId),
            this.readModel.capabilityNeeds(input.missionId)
          ]);
          const enactment = this.repairEnactment.plan({
            missionId: input.missionId,
            gap: blockingGap,
            diagnosis,
            invocationReceipts: invocationReceipts.filter(receipt => relatedWorkIds.has(receipt.workItemId)),
            capabilityNeeds,
            repairSequence: priorRepairCount + 1
          });
          if (enactment.failedCapabilityRef) {
            await this.emit(input.missionId, "capability.invalidated", {
              id: enactment.failedCapabilityRef,
              reason: diagnosis.rootCause,
              gapId: blockingGap.id,
              decisionId: decision.id
            }, { type: "controller" }, `capability-invalidated:${blockingGap.id}:${enactment.failedCapabilityRef}`);
          }
          if (enactment.replacementNeed) {
            await this.emit(input.missionId, "capability.need.created", { need: enactment.replacementNeed }, { type: "controller" }, `capability-need:${enactment.replacementNeed.id}`);
          }
          const repair = this.repairWorkItem(
            state,
            blockingGap,
            diagnosis,
            priorRepairCount + 1,
            enactment.executionConstraints,
            enactment.replacementNeed?.id
          );
          await this.proposeWork(repair);
          workItemsCreated.push(repair.id);
        }
        await this.emit(input.missionId, "decision.applied", { id: decision.id }, { type: "controller" }, `decision-applied:${decision.id}`);
        state = await this.state(input.missionId);
      }
    }

    if (this.deliberation && (this.shouldPlanFrontier(state) || (input.trigger === "user_steering" && state.blockingGapIds.length === 0))) {
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

  private decisionForDiagnosis(missionId: string, gap: Gap, diagnosis: GapDiagnosis): MissionDecision {
    const type: MissionDecision["type"] = diagnosis.intervention === "replace_executor" ? "replace_executor"
      : diagnosis.intervention === "replace_capability" ? "replace_capability"
      : diagnosis.intervention === "replan_local" ? "replan_local"
      : diagnosis.intervention === "revise_strategy" ? "revise_strategy"
      : diagnosis.intervention === "retry" ? "retry"
      : "revise_work";
    return {
      id: randomUUID(),
      missionId,
      type,
      targetRefs: [gap.id],
      rationale: `${diagnosis.rootCause} [repair_scope=${diagnosis.repairScope ?? "work_item"}]`,
      evidenceRefs: [...(diagnosis.evidenceRefs ?? [])],
      gapRefs: [gap.id],
      requirementRefs: [...gap.requirementRefs],
      expectedImpact: `Resolve ${gap.severity} gap ${gap.id} with the minimum sufficient repair scope`,
      confidence: diagnosis.confidence,
      requiresApproval: false,
      status: "proposed",
      createdAt: new Date().toISOString()
    };
  }

  private repairWorkItem(
    state: MissionState,
    gap: Gap,
    diagnosis: GapDiagnosis,
    sequence: number,
    executionConstraints?: import("../domain/work-item.ts").WorkExecutionConstraints,
    replacementNeedRef?: string
  ): WorkItem {
    const now = new Date().toISOString();
    const id = sequence <= 1 ? `repair-${gap.id}` : `repair-${gap.id}-${sequence}`;
    return {
      id,
      missionId: state.missionId,
      purpose: "repair",
      objective: `Resolve gap: ${gap.description}. Diagnosed cause: ${diagnosis.rootCause}. Repair scope: ${diagnosis.repairScope ?? "work_item"}`,
      status: "ready",
      requirementRefs: [...gap.requirementRefs],
      gapRefs: [gap.id],
      inputArtifactRefs: [...gap.artifactRefs],
      expectedOutputs: [],
      localAcceptanceCriteria: [{ id: `resolve-${gap.id}`, description: `Gap ${gap.id} is resolved and independently verified`, priority: "required" }],
      capabilityNeedRefs: replacementNeedRef ? [replacementNeedRef] : [],
      executionConstraints,
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
function validateBudget(budget: MissionBudget): void {
  for (const [key, value] of Object.entries(budget)) {
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) throw new Error(`Invalid mission budget ${key}`);
  }
}

function validateUsage(usage: CostEvent["usage"]): void {
  for (const [key, value] of Object.entries(usage)) {
    if (key === "source" || value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`Invalid measured usage ${key}`);
  }
}

function budgetFingerprint(budget: MissionBudget): string {
  return JSON.stringify(Object.fromEntries(Object.entries(budget).sort(([a], [b]) => a.localeCompare(b))));
}

function definedPatch<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function sameRequirementMeaning(a: Requirement, b: Requirement): boolean {
  return a.description === b.description && a.type === b.type && a.priority === b.priority && a.verification === b.verification;
}

function acceptanceChangedRequirements(current: AcceptanceContract | null, revised: SteeringInterpretation["revisedAcceptanceContract"]): string[] {
  if (!revised) return [];
  const changed = new Set<string>();
  const oldRequirements = new Map((current?.requirements ?? []).map(item => [item.id, item]));
  const newRequirements = new Map(revised.requirements.map(item => [item.id, item]));
  for (const [id, item] of oldRequirements) if (!newRequirements.has(id) || !sameRequirementMeaning(item, newRequirements.get(id)!)) changed.add(id);
  for (const [id, item] of newRequirements) if (!oldRequirements.has(id) || !sameRequirementMeaning(oldRequirements.get(id)!, item)) changed.add(id);
  const oldArtifacts = new Map((current?.requiredArtifacts ?? []).map(item => [item.logicalName, item]));
  for (const artifact of revised.requiredArtifacts) {
    const old = oldArtifacts.get(artifact.logicalName);
    if (!old || JSON.stringify(old) !== JSON.stringify(artifact)) for (const ref of artifact.requirementRefs) changed.add(ref);
    oldArtifacts.delete(artifact.logicalName);
  }
  for (const artifact of oldArtifacts.values()) for (const ref of artifact.requirementRefs) changed.add(ref);
  const oldValidations = new Map((current?.requiredValidations ?? []).map(item => [item.id, item]));
  for (const validation of revised.requiredValidations) {
    const old = oldValidations.get(validation.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(validation)) for (const ref of validation.requirementRefs) changed.add(ref);
    oldValidations.delete(validation.id);
  }
  for (const validation of oldValidations.values()) for (const ref of validation.requirementRefs) changed.add(ref);
  return [...changed];
}
