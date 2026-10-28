import { randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { MissionDecision } from "../domain/decision.ts";
import type { MissionEventType } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { Finding, Gap, VerificationResult } from "../domain/verification.ts";
import type { WorkItem } from "../domain/work-item.ts";
import { ContextCompiler } from "../context/context-compiler.ts";
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

export class MissionController {
  private readonly store: EventStore;
  private readonly deliberation?: DeliberationProvider;
  private readonly executionDriver?: WorkExecutionDriver;
  private readonly verifier?: Verifier;
  private readonly contextCompiler = new ContextCompiler();

  constructor(
    store: EventStore,
    deliberation?: DeliberationProvider,
    executionDriver?: WorkExecutionDriver,
    verifier?: Verifier
  ) {
    this.store = store;
    this.deliberation = deliberation;
    this.executionDriver = executionDriver;
    this.verifier = verifier;
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
    const executionsDispatched: string[] = [];
    const verificationsScheduled: string[] = [];

    let view = await this.cycleView(input.missionId);
    if (view.state.status === "completed") {
      return result(view.state, decisionsCreated, workItemsCreated, executionsDispatched, verificationsScheduled);
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
      const state = await this.state(missionId);
      if (!state.readyWorkItemIds.includes(work.id)) continue;

      const attemptId = `attempt:${work.id}:${state.revision}`;
      const executionId = `execution:${work.id}:${state.revision}`;
      const contextPacket = this.contextCompiler.compile({ state, workItem: work, capabilityRefs: [] });

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
          executionId
        });
        assertExecutionOutcome(missionId, work, attemptId, executionId, outcome);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.emit(missionId, "execution.failed", { id: executionId, workItemId: work.id, attemptId, error: message }, { type: "host" }, `execution-failed:${executionId}`);
        await this.emit(missionId, "attempt.completed", { id: attemptId, status: "failed", failureCategory: "runtime" }, { type: "controller" }, `attempt-completed:${attemptId}`);
        await this.emit(missionId, "work.failed", { id: work.id, attemptId, reason: message }, { type: "controller" }, `work-failed:${attemptId}`);
        await this.openGap(missionId, {
          id: `runtime-gap:${work.id}:${attemptId}`,
          severity: "major",
          description: `Execution failed for ${work.id}: ${message}`,
          blocking: true,
          category: "runtime",
          requirementRefs: work.requirementRefs,
          artifactRefs: work.inputArtifactRefs
        });
        continue;
      }

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
        continue;
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
            if (!verification.passed) verificationFailed = true;
          }
        }
      }

      if (verificationFailed) {
        await this.emit(missionId, "attempt.completed", { id: attemptId, status: "failed", failureCategory: "verification" }, { type: "controller" }, `attempt-completed:${attemptId}`);
        await this.emit(missionId, "work.failed", { id: work.id, attemptId, reason: "verification failed" }, { type: "controller" }, `work-failed:${attemptId}`);
      } else {
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
    }

    return { executions, verifications };
  }

  private async verifyArtifact(
    missionId: string,
    work: WorkItem,
    artifact: Artifact,
    attemptId: string
  ): Promise<{ runId: string; passed: boolean }> {
    const ref = artifactRef(artifact);
    const runId = `verification:${work.id}:${attemptId}:${artifact.id}:${artifact.version}`;
    await this.emit(
      missionId,
      "verification.started",
      { id: runId, artifactRef: ref, verifierId: this.verifier!.id },
      { type: "verifier", id: this.verifier!.id },
      `verification-started:${runId}`
    );

    let raw: VerificationResult;
    try {
      raw = await this.verifier!.verify(artifact);
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
      return { runId, passed: false };
    }

    if (raw.missionId !== missionId || raw.artifactRef !== ref) {
      throw new Error(`Verifier returned mismatched identity for ${ref}`);
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
      findingRefs: unique([...raw.findingRefs, ...generatedFindings.map(finding => finding.id)])
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
      return { runId, passed: true };
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
    return { runId, passed: false };
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
