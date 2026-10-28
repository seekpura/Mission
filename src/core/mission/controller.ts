import { randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { ExecutionRuntimeBinding } from "../domain/execution.ts";
import type { MissionDecision } from "../domain/decision.ts";
import type { MissionEventType } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { Finding, Gap, GapAssessment, VerificationResult } from "../domain/verification.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { CapabilityRuntime } from "../capabilities/capability-coordinator.ts";
import { ContextCompiler } from "../context/context-compiler.ts";
import { activeExecutions } from "../execution/recovery-view.ts";
import type { WorkExecutionDriver, WorkExecutionOutcome } from "../execution/work-execution-driver.ts";
import type { EventStore } from "../events/event-store.ts";
import { projectMissionState } from "../events/state-projector.ts";
import type {
  CompletionChallenge,
  DeliberationProvider,
  GapDiagnosis,
  StrategyProposal
} from "../planning/deliberation-provider.ts";
import type { Verifier } from "../verification/verifier.ts";
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

interface WorkCapabilityResolution {
  ok: boolean;
  capabilityRefs: string[];
}

interface VerificationOutcome {
  runId: string;
  verificationId?: string;
  artifactRef: string;
  passed: boolean;
  evidenceRefs: string[];
  gapAssessments: GapAssessment[];
}

interface GapEvidenceAggregate {
  statuses: Set<GapAssessment["status"]>;
  verificationRefs: Set<string>;
  artifactRefs: Set<string>;
  evidenceRefs: Set<string>;
  details: string[];
}

export class MissionController {
  private readonly store: EventStore;
  private readonly deliberation?: DeliberationProvider;
  private readonly executionDriver?: WorkExecutionDriver;
  private readonly verifier?: Verifier;
  private readonly capabilities?: CapabilityRuntime;
  private readonly contextCompiler = new ContextCompiler();

  constructor(
    store: EventStore,
    deliberation?: DeliberationProvider,
    executionDriver?: WorkExecutionDriver,
    verifier?: Verifier,
    capabilities?: CapabilityRuntime
  ) {
    this.store = store;
    this.deliberation = deliberation;
    this.executionDriver = executionDriver;
    this.verifier = verifier;
    this.capabilities = capabilities;
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

  async resolveGap(
    missionId: string,
    gapId: string,
    evidence?: {
      verificationRefs?: string[];
      artifactRefs?: string[];
      evidenceRefs?: string[];
      detail?: string;
    }
  ) {
    await this.emit(
      missionId,
      "gap.resolved",
      {
        id: gapId,
        ...(evidence?.verificationRefs ? { verificationRefs: [...evidence.verificationRefs] } : {}),
        ...(evidence?.artifactRefs ? { artifactRefs: [...evidence.artifactRefs] } : {}),
        ...(evidence?.evidenceRefs ? { evidenceRefs: [...evidence.evidenceRefs] } : {}),
        ...(evidence?.detail ? { detail: evidence.detail } : {})
      },
      { type: "verifier" },
      `gap-resolved:${gapId}`
    );
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
    const executionsDispatched: string[] = [];
    const verificationsScheduled: string[] = [];

    let view = await this.cycleView(input.missionId);
    if (view.state.status === "completed") {
      return result(view.state, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
    }

    this.capabilities?.restoreMissionCapabilities(input.missionId, view.journal.capabilities.values());

    if (view.state.activeExecutionIds.length > 0) {
      const recovery = await this.recoverActiveExecutions(input.missionId, view);
      executionsDispatched.push(...recovery.executions);
      verificationsScheduled.push(...recovery.verifications);
      if (recovery.executions.length > 0) view = await this.cycleView(input.missionId);
    }

    if (this.deliberation) {
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
        const admittedNeeds = admitCapabilityNeeds(input.missionId, view, proposal.capabilityNeeds ?? []);
        for (const need of admittedNeeds) {
          await this.emit(
            input.missionId,
            "capability.need.created",
            { id: need.id, need },
            { type: "planner" },
            `capability-need:${need.id}`
          );
        }
        if (admittedNeeds.length > 0) view = await this.cycleView(input.missionId);

        const admitted = admitFrontier(input.missionId, view, proposal.workItems);
        if (admitted.length > 0) {
          const graphRevision = Math.max(view.state.graphRevision + 1, proposal.graphRevision);
          await this.emit(
            input.missionId,
            "graph.revised",
            {
              revision: graphRevision,
              workItemIds: admitted.map(work => work.id),
              capabilityNeedIds: admittedNeeds.map(need => need.id)
            },
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
    }

    if (this.executionDriver && view.state.readyWorkItemIds.length > 0) {
      const dispatch = await this.dispatchReadyWork(input.missionId, view);
      executionsDispatched.push(...dispatch.executions);
      verificationsScheduled.push(...dispatch.verifications);
      view = await this.cycleView(input.missionId);
    }

    if (this.deliberation && completionGateEligible(view.state)) {
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
        return result(view.state, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
      }

      await this.emit(
        input.missionId,
        "decision.applied",
        { id: decisionId },
        { type: "controller" },
        `decision-applied:${decisionId}`
      );
      const completed = await this.completeIfEligible(input.missionId);
      return result(completed, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
    }

    if (!this.deliberation) {
      const after = await this.completeIfEligible(input.missionId);
      return result(after, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
    }

    view = await this.cycleView(input.missionId);
    return result(view.state, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
  }

  async state(missionId: string) {
    return projectMissionState(missionId, await this.store.list(missionId));
  }

  private async recoverActiveExecutions(
    missionId: string,
    initialView: CycleView
  ): Promise<{ executions: string[]; verifications: string[] }> {
    const executions: string[] = [];
    const verifications: string[] = [];
    const active = activeExecutions(await this.store.list(missionId));

    for (const execution of active) {
      if (this.executionDriver?.isActive?.(execution.executionId)) continue;
      const currentView = await this.cycleView(missionId);
      const work = currentView.journal.workItems.get(execution.workItemId) ?? initialView.journal.workItems.get(execution.workItemId);
      if (!work) {
        await this.emit(
          missionId,
          "execution.lost",
          { id: execution.executionId, attemptId: execution.attemptId, reason: "Recovery could not reconstruct the WorkItem." },
          { type: "controller" },
          `execution-lost:${execution.executionId}`
        );
        executions.push(execution.executionId);
        continue;
      }

      if (!execution.binding) {
        await this.recordRuntimeFailure(
          missionId,
          work,
          execution.attemptId,
          execution.executionId,
          "execution.lost",
          `Active execution ${execution.executionId} has no durable runtime binding.`
        );
        executions.push(execution.executionId);
        continue;
      }
      if (!this.executionDriver?.recover) {
        await this.recordRuntimeFailure(
          missionId,
          work,
          execution.attemptId,
          execution.executionId,
          "execution.lost",
          `Execution driver cannot recover active execution ${execution.executionId}.`
        );
        executions.push(execution.executionId);
        continue;
      }

      const state = await this.state(missionId);
      const contextPacket = this.contextCompiler.compile({
        state,
        workItem: work,
        capabilityRefs: execution.capabilityRefs
      });
      const recoveryOrdinal = execution.recoveryCount + 1;
      await this.emit(
        missionId,
        "execution.recovery.started",
        {
          id: execution.executionId,
          workItemId: work.id,
          attemptId: execution.attemptId,
          recoveryOrdinal,
          originalContextPacketId: execution.contextPacketId,
          recoveryContextPacketId: contextPacket.id,
          binding: execution.binding
        },
        { type: "controller" },
        `execution-recovery-started:${execution.executionId}:${recoveryOrdinal}`
      );
      executions.push(execution.executionId);

      let outcome: WorkExecutionOutcome;
      try {
        outcome = await this.executionDriver.recover({
          state,
          workItem: work,
          contextPacket,
          attemptId: execution.attemptId,
          executionId: execution.executionId,
          binding: execution.binding
        });
        assertExecutionOutcome(missionId, work, execution.attemptId, execution.executionId, outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordRuntimeFailure(
          missionId,
          work,
          execution.attemptId,
          execution.executionId,
          "execution.failed",
          `Execution recovery failed for ${work.id}: ${message}`
        );
        continue;
      }

      const settled = await this.settleExecutionOutcome(missionId, work, execution.attemptId, outcome);
      verifications.push(...settled.verifications);
    }

    return { executions, verifications };
  }

  private async dispatchReadyWork(
    missionId: string,
    initialView: CycleView
  ): Promise<{ executions: string[]; verifications: string[] }> {
    const executions: string[] = [];
    const verifications: string[] = [];
    const ready = initialView.state.readyWorkItemIds
      .map(id => initialView.journal.workItems.get(id))
      .filter((work): work is WorkItem => Boolean(work))
      .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

    for (const work of ready) {
      let state = await this.state(missionId);
      if (!state.readyWorkItemIds.includes(work.id)) continue;

      const capabilityResolution = await this.resolveWorkCapabilities(missionId, work);
      if (!capabilityResolution.ok) continue;

      state = await this.state(missionId);
      if (!state.readyWorkItemIds.includes(work.id)) continue;

      const attemptId = `attempt:${work.id}:${state.revision}`;
      const executionId = `execution:${work.id}:${state.revision}`;
      const contextPacket = this.contextCompiler.compile({
        state,
        workItem: work,
        capabilityRefs: capabilityResolution.capabilityRefs
      });

      await this.emit(
        missionId,
        "attempt.created",
        {
          id: attemptId,
          workItemId: work.id,
          executorId: this.executionDriver!.id,
          contextPacketId: contextPacket.id,
          capabilityRefs: contextPacket.allowedCapabilityRefs,
          executionIds: [executionId]
        },
        { type: "controller" },
        `attempt-created:${attemptId}`
      );
      await this.emit(missionId, "work.started", { id: work.id, attemptId }, { type: "controller" }, `work-started:${attemptId}`);
      await this.emit(
        missionId,
        "execution.created",
        { id: executionId, workItemId: work.id, attemptId, executorId: this.executionDriver!.id, contextPacketId: contextPacket.id },
        { type: "controller" },
        `execution-created:${executionId}`
      );
      await this.emit(missionId, "execution.started", { id: executionId, workItemId: work.id, attemptId }, { type: "host" }, `execution-started:${executionId}`);
      executions.push(executionId);

      let outcome: WorkExecutionOutcome;
      try {
        outcome = await this.executionDriver!.execute({
          state,
          workItem: work,
          contextPacket,
          attemptId,
          executionId,
          lifecycle: {
            bindRuntime: async binding => {
              assertRuntimeBinding(work, attemptId, executionId, binding);
              await this.emit(
                missionId,
                "execution.bound",
                { id: executionId, binding },
                { type: "host", id: binding.driverId },
                `execution-bound:${executionId}`
              );
            }
          }
        });
        assertExecutionOutcome(missionId, work, attemptId, executionId, outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.recordRuntimeFailure(
          missionId,
          work,
          attemptId,
          executionId,
          "execution.failed",
          `Execution failed for ${work.id}: ${message}`
        );
        continue;
      }

      const settled = await this.settleExecutionOutcome(missionId, work, attemptId, outcome);
      verifications.push(...settled.verifications);
    }

    return { executions, verifications };
  }

  private async settleExecutionOutcome(
    missionId: string,
    work: WorkItem,
    attemptId: string,
    outcome: WorkExecutionOutcome
  ): Promise<{ verifications: string[] }> {
    const verifications: string[] = [];
    const executionId = outcome.result.executionId;
    await this.emitExecutionTerminal(missionId, work, attemptId, outcome);
    if (outcome.result.state !== "succeeded") {
      await this.emit(missionId, "attempt.completed", { id: attemptId, status: "failed", failureCategory: outcome.result.state }, { type: "controller" }, `attempt-completed:${attemptId}`);
      await this.emit(missionId, "work.failed", { id: work.id, attemptId, reason: `execution ${outcome.result.state}` }, { type: "controller" }, `work-failed:${attemptId}`);
      await this.openGap(missionId, {
        id: `runtime-gap:${work.id}:${attemptId}`,
        severity: "major",
        description: `Execution ${executionId} ended in state ${outcome.result.state}.`,
        blocking: true,
        category: "runtime",
        requirementRefs: work.requirementRefs,
        artifactRefs: work.inputArtifactRefs
      });
      return { verifications };
    }

    for (const artifact of outcome.artifacts) {
      const ref = artifactRef(artifact);
      await this.emit(
        missionId,
        "artifact.created",
        { artifactRef: ref, artifact },
        { type: "worker", id: this.executionDriver!.id },
        `artifact-created:${ref}`
      );
    }

    const missing = missingRequiredOutputs(work, outcome.artifacts);
    let verificationFailed = false;
    const gapEvidence = new Map<string, GapEvidenceAggregate>();
    for (const expected of missing) {
      verificationFailed = true;
      await this.openGap(missionId, {
        id: `missing-output:${work.id}:${attemptId}:${expected.logicalName}`,
        severity: "major",
        description: `Required output ${expected.logicalName} (${expected.type}) was not produced by ${work.id}.`,
        blocking: true,
        category: "missing_output",
        requirementRefs: work.requirementRefs,
        artifactRefs: work.inputArtifactRefs
      });
    }

    if (outcome.artifacts.length > 0) {
      await this.emit(missionId, "work.updated", { id: work.id, status: "verifying" }, { type: "controller" }, `work-verifying:${attemptId}`);
      if (!this.verifier) {
        verificationFailed = true;
        await this.openGap(missionId, {
          id: `verification-capability:${work.id}:${attemptId}`,
          severity: "major",
          description: `Artifacts were produced for ${work.id}, but no independent verifier is configured.`,
          blocking: true,
          category: "capability",
          requirementRefs: work.requirementRefs,
          artifactRefs: outcome.artifacts.map(artifactRef)
        });
      } else {
        for (const artifact of outcome.artifacts) {
          const verification = await this.verifyArtifact(missionId, work, artifact, attemptId);
          verifications.push(verification.runId);
          mergeGapEvidence(gapEvidence, verification);
          if (!verification.passed) verificationFailed = true;
        }
      }
    }

    if (verificationFailed) {
      await this.emit(missionId, "attempt.completed", { id: attemptId, status: "failed", failureCategory: "verification" }, { type: "controller" }, `attempt-completed:${attemptId}`);
      await this.emit(missionId, "work.failed", { id: work.id, attemptId, reason: "verification failed" }, { type: "controller" }, `work-failed:${attemptId}`);
    } else {
      await this.resolveVerifiedGaps(missionId, work, gapEvidence);
      await this.emit(
        missionId,
        "attempt.completed",
        { id: attemptId, status: "succeeded", artifactRefs: outcome.artifacts.map(artifactRef) },
        { type: "controller" },
        `attempt-completed:${attemptId}`
      );
      await this.emit(
        missionId,
        "work.completed",
        { id: work.id, attemptId, artifactRefs: outcome.artifacts.map(artifactRef) },
        { type: "controller" },
        `work-completed:${attemptId}`
      );
    }
    return { verifications };
  }

  private async recordRuntimeFailure(
    missionId: string,
    work: WorkItem,
    attemptId: string,
    executionId: string,
    terminalType: "execution.failed" | "execution.lost",
    reason: string
  ): Promise<void> {
    await this.emit(
      missionId,
      terminalType,
      { id: executionId, workItemId: work.id, attemptId, error: reason },
      { type: "host", id: this.executionDriver?.id },
      `${terminalType}:${executionId}`
    );
    await this.emit(
      missionId,
      "attempt.completed",
      { id: attemptId, status: "failed", failureCategory: terminalType === "execution.lost" ? "lost" : "runtime" },
      { type: "controller" },
      `attempt-completed:${attemptId}`
    );
    await this.emit(
      missionId,
      "work.failed",
      { id: work.id, attemptId, reason },
      { type: "controller" },
      `work-failed:${attemptId}`
    );
    await this.openGap(missionId, {
      id: `runtime-gap:${work.id}:${attemptId}`,
      severity: "major",
      description: reason,
      blocking: true,
      category: "runtime",
      requirementRefs: work.requirementRefs,
      artifactRefs: work.inputArtifactRefs
    });
  }

  private async resolveWorkCapabilities(
    missionId: string,
    work: WorkItem
  ): Promise<WorkCapabilityResolution> {
    if (work.capabilityNeedRefs.length === 0) return { ok: true, capabilityRefs: [] };

    let view = await this.cycleView(missionId);
    this.capabilities?.restoreMissionCapabilities(missionId, view.journal.capabilities.values());
    const capabilityRefs: string[] = [];

    for (const needRef of work.capabilityNeedRefs) {
      const need = view.journal.capabilityNeeds.get(needRef);
      if (!need) {
        await this.blockWorkForCapability(
          missionId,
          work,
          needRef,
          undefined,
          `Work ${work.id} references unknown capability need ${needRef}.`
        );
        return { ok: false, capabilityRefs: [] };
      }

      if (!this.capabilities) {
        await this.blockWorkForCapability(
          missionId,
          work,
          needRef,
          need,
          `Work ${work.id} requires capability need ${needRef}, but no capability runtime is configured.`
        );
        return { ok: false, capabilityRefs: [] };
      }

      const ensured = await this.capabilities.ensure(need);
      if (ensured.status !== "resolved" || !ensured.capability) {
        await this.blockWorkForCapability(
          missionId,
          work,
          needRef,
          need,
          `Capability need ${needRef} could not be resolved: ${ensured.reason}`
        );
        return { ok: false, capabilityRefs: [] };
      }

      const capability = ensured.capability;
      await this.emit(
        missionId,
        "capability.activated",
        {
          capabilityNeedId: need.id,
          capability,
          source: ensured.source,
          reason: ensured.reason,
          attempts: ensured.attempts
        },
        { type: "controller" },
        `capability-activated:${need.id}:${capability.id}:${capability.revision ?? capability.invocationRef ?? "current"}`
      );
      capabilityRefs.push(capability.id);
      view = await this.cycleView(missionId);
      this.capabilities.restoreMissionCapabilities(missionId, view.journal.capabilities.values());
    }

    return { ok: true, capabilityRefs: unique(capabilityRefs) };
  }

  private async blockWorkForCapability(
    missionId: string,
    work: WorkItem,
    needRef: string,
    need: CapabilityNeed | undefined,
    reason: string
  ): Promise<void> {
    await this.emit(
      missionId,
      "work.blocked",
      { id: work.id, reason, capabilityNeedRef: needRef },
      { type: "controller" },
      `work-blocked:capability:${work.id}:${needRef}`
    );
    await this.openGap(missionId, {
      id: `capability-gap:${work.id}:${needRef}`,
      severity: "major",
      description: reason,
      blocking: true,
      category: "capability",
      requirementRefs: unique([...work.requirementRefs, ...(need?.requirementRefs ?? [])]),
      artifactRefs: work.inputArtifactRefs
    });
  }

  private async verifyArtifact(
    missionId: string,
    work: WorkItem,
    artifact: Artifact,
    attemptId: string
  ): Promise<VerificationOutcome> {
    const ref = artifactRef(artifact);
    const runId = `verification:${work.id}:${attemptId}:${artifact.id}:${artifact.version}`;
    await this.emit(
      missionId,
      "verification.started",
      { id: runId, artifactRef: ref, verifierId: this.verifier!.id },
      { type: "verifier", id: this.verifier!.id },
      `verification-started:${runId}`
    );

    const verificationView = await this.cycleView(missionId);
    const relevantGaps = work.gapRefs
      .map(gapId => verificationView.journal.gaps.get(gapId))
      .filter((gap): gap is Gap => Boolean(gap) && (gap!.status === "open" || gap!.status === "working" || gap!.status === "blocked"));
    const allowedGapIds = new Set(relevantGaps.map(gap => gap.id));

    let raw: VerificationResult;
    try {
      raw = await this.verifier!.verify(artifact, {
        state: verificationView.state,
        workItem: work,
        gaps: relevantGaps
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.emit(
        missionId,
        "verification.completed",
        { id: runId, artifactRef: ref, verifierId: this.verifier!.id, overall: "inconclusive", error: message },
        { type: "verifier", id: this.verifier!.id },
        `verification-completed:${runId}`
      );
      await this.openGap(missionId, {
        id: `verification-gap:${runId}`,
        severity: "major",
        description: `Verifier ${this.verifier!.id} failed for ${ref}: ${message}`,
        blocking: true,
        category: "runtime",
        requirementRefs: work.requirementRefs,
        artifactRefs: [ref]
      });
      return { runId, artifactRef: ref, passed: false, evidenceRefs: [], gapAssessments: [] };
    }

    const protocolError = verifierProtocolError(raw, missionId, ref, allowedGapIds);
    if (protocolError) {
      await this.emit(
        missionId,
        "verification.completed",
        { id: runId, artifactRef: ref, verifierId: this.verifier!.id, overall: "inconclusive", error: protocolError },
        { type: "verifier", id: this.verifier!.id },
        `verification-completed:${runId}`
      );
      await this.openGap(missionId, {
        id: `verification-gap:${runId}`,
        severity: "major",
        description: `Verifier ${this.verifier!.id} returned an invalid result for ${ref}: ${protocolError}`,
        blocking: true,
        category: "runtime",
        requirementRefs: work.requirementRefs,
        artifactRefs: [ref]
      });
      return { runId, artifactRef: ref, passed: false, evidenceRefs: [], gapAssessments: [] };
    }

    const generatedFindings = synthesizeFindings(work, raw);
    for (const finding of generatedFindings) {
      await this.emit(
        missionId,
        "finding.created",
        finding,
        { type: "verifier", id: raw.verifierId },
        `finding-created:${finding.id}`
      );
    }
    const verification: VerificationResult = {
      ...raw,
      findingRefs: unique([...raw.findingRefs, ...generatedFindings.map(finding => finding.id)]),
      gapAssessments: (raw.gapAssessments ?? []).map(assessment => ({
        ...assessment,
        evidenceRefs: [...assessment.evidenceRefs]
      }))
    };
    await this.emit(
      missionId,
      "verification.completed",
      { id: runId, result: verification },
      { type: "verifier", id: verification.verifierId },
      `verification-completed:${runId}`
    );

    const passed = verification.overall === "pass" || verification.overall === "pass_with_warnings";
    if (passed) {
      await this.validateArtifact(missionId, ref, verification.level === "mission");
      return {
        runId,
        verificationId: verification.id,
        artifactRef: ref,
        passed: true,
        evidenceRefs: [...verification.evidenceRefs],
        gapAssessments: verification.gapAssessments ?? []
      };
    }

    await this.emit(
      missionId,
      "artifact.invalidated",
      { artifactRef: ref, verificationId: verification.id },
      { type: "verifier", id: verification.verifierId },
      `artifact-invalidated:${ref}:${verification.id}`
    );
    await this.openGap(missionId, {
      id: `verification-gap:${runId}`,
      severity: verification.overall === "fail" ? "major" : "minor",
      description: `Independent verification ${verification.id} returned ${verification.overall} for ${ref}.`,
      blocking: verification.overall === "fail",
      category: "quality",
      findingRefs: verification.findingRefs,
      requirementRefs: work.requirementRefs,
      artifactRefs: [ref]
    });
    return {
      runId,
      verificationId: verification.id,
      artifactRef: ref,
      passed: false,
      evidenceRefs: [...verification.evidenceRefs],
      gapAssessments: verification.gapAssessments ?? []
    };
  }

  private async resolveVerifiedGaps(
    missionId: string,
    work: WorkItem,
    aggregate: Map<string, GapEvidenceAggregate>
  ): Promise<void> {
    if (work.gapRefs.length === 0 || aggregate.size === 0) return;
    const view = await this.cycleView(missionId);

    for (const gapId of work.gapRefs) {
      const evidence = aggregate.get(gapId);
      const current = view.journal.gaps.get(gapId);
      if (!evidence || !current) continue;
      if (current.status !== "open" && current.status !== "working" && current.status !== "blocked") continue;
      if (!evidence.statuses.has("resolved")) continue;
      if (evidence.statuses.has("still_open") || evidence.statuses.has("inconclusive")) continue;

      await this.resolveGap(missionId, gapId, {
        verificationRefs: [...evidence.verificationRefs],
        artifactRefs: [...evidence.artifactRefs],
        evidenceRefs: [...evidence.evidenceRefs],
        detail: evidence.details.filter(Boolean).join(" | ") || "Independent verification explicitly assessed this gap as resolved."
      });
    }
  }

  private async emitExecutionTerminal(
    missionId: string,
    work: WorkItem,
    attemptId: string,
    outcome: WorkExecutionOutcome
  ): Promise<void> {
    const payload = { id: outcome.result.executionId, workItemId: work.id, attemptId, result: outcome.result };
    const type: MissionEventType = outcome.result.state === "succeeded" || outcome.result.state === "partial"
      ? "execution.completed"
      : outcome.result.state === "cancelled"
        ? "execution.cancelled"
        : outcome.result.state === "lost"
          ? "execution.lost"
          : "execution.failed";
    await this.emit(missionId, type, payload, { type: "host", id: this.executionDriver!.id }, `${type}:${outcome.result.executionId}`);
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

function admitCapabilityNeeds(
  missionId: string,
  view: CycleView,
  proposed: CapabilityNeed[]
): CapabilityNeed[] {
  const admitted: CapabilityNeed[] = [];
  const seen = new Map<string, CapabilityNeed>();

  for (const need of proposed) {
    if (need.missionId !== missionId) {
      throw new Error(`Planner proposed capability need for wrong mission: ${need.id}`);
    }
    const priorProposal = seen.get(need.id);
    if (priorProposal) {
      if (!sameCapabilityNeed(priorProposal, need)) {
        throw new Error(`Planner proposed conflicting capability need definitions: ${need.id}`);
      }
      continue;
    }
    seen.set(need.id, need);

    const existing = view.journal.capabilityNeeds.get(need.id);
    if (existing) {
      if (!sameCapabilityNeed(existing, need)) {
        throw new Error(`Planner attempted to redefine capability need ${need.id}`);
      }
      continue;
    }
    admitted.push(need);
  }

  return admitted;
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
    for (const needRef of work.capabilityNeedRefs) {
      if (!view.journal.capabilityNeeds.has(needRef)) {
        throw new Error(`Planner work ${work.id} references unknown capability need ${needRef}`);
      }
    }
    seen.add(work.id);
    admitted.push(work);
  }
  return admitted;
}

function sameCapabilityNeed(left: CapabilityNeed, right: CapabilityNeed): boolean {
  return JSON.stringify(normalizeCapabilityNeed(left)) === JSON.stringify(normalizeCapabilityNeed(right));
}

function normalizeCapabilityNeed(need: CapabilityNeed) {
  return {
    id: need.id,
    missionId: need.missionId,
    objective: need.objective,
    requiredFunctions: [...need.requiredFunctions],
    desiredInputs: [...need.desiredInputs],
    desiredOutputs: [...need.desiredOutputs],
    purpose: need.purpose,
    urgency: need.urgency,
    acquisitionAllowed: need.acquisitionAllowed,
    maxRisk: need.maxRisk,
    requirementRefs: [...need.requirementRefs],
    gapRefs: [...need.gapRefs]
  };
}

function assertRuntimeBinding(
  work: WorkItem,
  attemptId: string,
  executionId: string,
  binding: ExecutionRuntimeBinding
): void {
  if (binding.executionId !== executionId) throw new Error(`Runtime binding execution mismatch for ${work.id}`);
  if (binding.attemptId !== attemptId) throw new Error(`Runtime binding attempt mismatch for ${work.id}`);
  if (binding.workItemId !== work.id) throw new Error(`Runtime binding work item mismatch for ${work.id}`);
  if (!binding.driverId.trim()) throw new Error(`Runtime binding missing driver id for ${work.id}`);
  if (!binding.hostHandleId.trim()) throw new Error(`Runtime binding missing host handle id for ${work.id}`);
  if (!binding.workspaceRoot.trim()) throw new Error(`Runtime binding missing workspace for ${work.id}`);
}

function assertExecutionOutcome(
  missionId: string,
  work: WorkItem,
  attemptId: string,
  executionId: string,
  outcome: WorkExecutionOutcome
): void {
  if (outcome.result.executionId !== executionId) {
    throw new Error(`Execution driver returned wrong execution id for ${work.id}`);
  }
  const refs = new Set(outcome.artifacts.map(artifactRef));
  for (const artifact of outcome.artifacts) {
    if (artifact.missionId !== missionId) throw new Error(`Execution driver returned artifact for wrong mission: ${artifactRef(artifact)}`);
    if (artifact.producedByAttemptId !== attemptId) throw new Error(`Execution driver returned artifact with wrong attempt: ${artifactRef(artifact)}`);
  }
  for (const ref of outcome.result.committedArtifactRefs) {
    if (!refs.has(ref)) throw new Error(`Execution result references missing artifact metadata: ${ref}`);
  }
  for (const ref of refs) {
    if (!outcome.result.committedArtifactRefs.includes(ref)) throw new Error(`Execution driver returned uncommitted artifact metadata: ${ref}`);
  }
}

function missingRequiredOutputs(work: WorkItem, artifacts: Artifact[]) {
  return work.expectedOutputs.filter(expected => expected.required && !artifacts.some(artifact =>
    artifact.logicalName === expected.logicalName && artifact.type === expected.type
  ));
}

function verifierProtocolError(
  raw: unknown,
  missionId: string,
  artifactReference: string,
  allowedGapIds: Set<string>
): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return `Verifier returned malformed result for ${artifactReference}`;
  }

  const candidate = raw as Partial<VerificationResult>;
  if (candidate.missionId !== missionId || candidate.artifactRef !== artifactReference) {
    return `Verifier returned mismatched identity for ${artifactReference}`;
  }
  if (typeof candidate.id !== "string" || candidate.id.length === 0) {
    return `Verifier returned missing verification id for ${artifactReference}`;
  }
  if (typeof candidate.verifierId !== "string" || candidate.verifierId.length === 0) {
    return `Verifier returned missing verifier id for ${artifactReference}`;
  }
  if (!Array.isArray(candidate.checkResults) || !Array.isArray(candidate.findingRefs) || !Array.isArray(candidate.evidenceRefs)) {
    return `Verifier returned malformed evidence collections for ${artifactReference}`;
  }
  if (!["structural", "functional", "quality", "integration", "mission"].includes(candidate.level ?? "")) {
    return `Verifier returned unsupported verification level for ${artifactReference}`;
  }
  if (!["pass", "pass_with_warnings", "fail", "inconclusive"].includes(candidate.overall ?? "")) {
    return `Verifier returned unsupported overall status for ${artifactReference}`;
  }
  if (candidate.gapAssessments !== undefined) {
    if (!Array.isArray(candidate.gapAssessments)) {
      return `Verifier returned malformed gap assessments for ${artifactReference}`;
    }
    for (const assessment of candidate.gapAssessments) {
      if (!assessment || typeof assessment !== "object") {
        return `Verifier returned malformed gap assessment for ${artifactReference}`;
      }
      if (typeof assessment.gapId !== "string" || !allowedGapIds.has(assessment.gapId)) {
        return `Verifier assessed an unrelated or closed gap for ${artifactReference}`;
      }
      if (!["resolved", "still_open", "inconclusive"].includes(assessment.status)) {
        return `Verifier returned unsupported gap assessment status for ${artifactReference}`;
      }
      if (!Array.isArray(assessment.evidenceRefs) || assessment.evidenceRefs.some(ref => typeof ref !== "string")) {
        return `Verifier returned malformed gap evidence refs for ${artifactReference}`;
      }
      if (typeof assessment.confidence !== "number" || !Number.isFinite(assessment.confidence) || assessment.confidence < 0 || assessment.confidence > 1) {
        return `Verifier returned invalid gap assessment confidence for ${artifactReference}`;
      }
      if (assessment.detail !== undefined && typeof assessment.detail !== "string") {
        return `Verifier returned invalid gap assessment detail for ${artifactReference}`;
      }
    }
  }
  return null;
}

function mergeGapEvidence(
  aggregate: Map<string, GapEvidenceAggregate>,
  verification: VerificationOutcome
): void {
  for (const assessment of verification.gapAssessments) {
    let current = aggregate.get(assessment.gapId);
    if (!current) {
      current = {
        statuses: new Set(),
        verificationRefs: new Set(),
        artifactRefs: new Set(),
        evidenceRefs: new Set(),
        details: []
      };
      aggregate.set(assessment.gapId, current);
    }
    current.statuses.add(assessment.status);
    if (verification.verificationId) current.verificationRefs.add(verification.verificationId);
    current.artifactRefs.add(verification.artifactRef);
    for (const ref of verification.evidenceRefs) current.evidenceRefs.add(ref);
    for (const ref of assessment.evidenceRefs) current.evidenceRefs.add(ref);
    if (assessment.detail) current.details.push(assessment.detail);
  }
}

function synthesizeFindings(work: WorkItem, verification: VerificationResult): Finding[] {
  return verification.checkResults
    .filter(check => check.status !== "pass")
    .map(check => ({
      id: `finding:${verification.id}:${check.id}`,
      missionId: verification.missionId,
      artifactRef: verification.artifactRef,
      category: findingCategory(verification.level),
      severity: check.status === "fail" ? "major" as const : "minor" as const,
      observation: check.detail ?? `Verification check ${check.id} returned ${check.status}.`,
      expected: `Verification check ${check.id} should pass.`,
      requirementRefs: [...work.requirementRefs],
      evidenceRefs: [...check.evidenceRefs],
      confidence: check.status === "inconclusive" ? 0.5 : 1,
      createdAt: new Date().toISOString()
    }));
}

function findingCategory(level: VerificationResult["level"]): Finding["category"] {
  if (level === "structural") return "structural";
  if (level === "functional") return "functional";
  if (level === "integration") return "integration";
  if (level === "mission") return "evidence";
  return "technical";
}

function challengeBlocks(challenge: CompletionChallenge): boolean {
  return challenge.blockingObjection || challenge.objections.some(objection => objection.severity === "blocking");
}

function completionRationale(challenge: CompletionChallenge): string {
  if (challenge.objections.length === 0) return "Independent completion challenge found no remaining objections.";
  return challenge.objections.map(objection => objection.description).join(" | ");
}

function artifactRef(artifact: Artifact): string {
  return `${artifact.id}@${artifact.version}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function result(
  state: MissionState,
  decisionsCreated: string[],
  workItemsCreated: string[],
  executionsDispatched: string[],
  verificationsScheduled: string[]
): ControllerCycleResult {
  return {
    missionRevision: state.revision,
    decisionsCreated,
    workItemsCreated,
    executionsDispatched,
    verificationsScheduled,
    status: state.status
  };
}
