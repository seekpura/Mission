import { randomUUID } from "node:crypto";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { Artifact } from "../../core/domain/artifact.ts";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import { ContextCompiler } from "../../core/context/context-compiler.ts";
import { parseWorkerOutput, workerProtocolInstruction, type WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import { ArtifactAssurancePipeline } from "./artifact-assurance-pipeline.ts";
import { HostAgentExecutionBackend, type HostAgentExecutionRequest } from "../../execution/host/host-agent-execution-backend.ts";
import type { CapabilityCoordinator } from "./capability-coordinator.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import type { FileArtifactStore } from "../../execution/artifacts/artifact-store.ts";
import type { Verifier } from "../../core/verification/verifier.ts";
import type { WorkExecutionRouter, ExecutionRoute } from "./executor-router.ts";
import type { InvocationReceipt } from "../../core/domain/invocation.ts";
import { writeExecutionRecoveryManifest } from "../recovery/recovery-manifest.ts";
import type { WorkerKnowledgeIngestor } from "../../core/knowledge/worker-knowledge-ingestor.ts";
import { KnowledgeContextSelector } from "../../core/context/knowledge-context-selector.ts";
import type { KnowledgeStalenessManager } from "../../core/knowledge/knowledge-staleness-manager.ts";
import type { BudgetManager } from "../../core/budget/budget-manager.ts";

export interface MissionOrchestratorOptions {
  maxConcurrency?: number;
  maxCyclesPerWake?: number;
}

export class MissionOrchestrator {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly contextCompiler: ContextCompiler;
  private readonly hostBackend: HostAgentExecutionBackend;
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly verifier: Verifier;
  private readonly maxConcurrency: number;
  private readonly maxCyclesPerWake: number;
  private readonly assurance: ArtifactAssurancePipeline;
  private readonly capabilityCoordinator?: CapabilityCoordinator;
  private readonly executionRouter?: WorkExecutionRouter;
  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;
  private readonly knowledge?: KnowledgeStalenessManager;
  private readonly budget?: BudgetManager;
  private readonly knowledgeSelector = new KnowledgeContextSelector();
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();
  private readonly activeExecutions = new Map<string, { missionId: string; workItemId: string; executionId: string }>();

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    hostBackend: HostAgentExecutionBackend;
    workspaces: WorkspaceManager;
    artifacts: FileArtifactStore;
    verifier: Verifier;
    contextCompiler?: ContextCompiler;
    capabilityCoordinator?: CapabilityCoordinator;
    executionRouter?: WorkExecutionRouter;
    knowledgeIngestor?: WorkerKnowledgeIngestor;
    knowledge?: KnowledgeStalenessManager;
    budget?: BudgetManager;
    assurance?: ArtifactAssurancePipeline;
    options?: MissionOrchestratorOptions;
  }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.hostBackend = input.hostBackend;
    this.workspaces = input.workspaces;
    this.artifacts = input.artifacts;
    this.verifier = input.verifier;
    this.contextCompiler = input.contextCompiler ?? new ContextCompiler();
    this.maxConcurrency = Math.max(1, input.options?.maxConcurrency ?? 4);
    this.maxCyclesPerWake = Math.max(1, input.options?.maxCyclesPerWake ?? 64);
    this.capabilityCoordinator = input.capabilityCoordinator;
    this.executionRouter = input.executionRouter;
    this.knowledgeIngestor = input.knowledgeIngestor;
    this.knowledge = input.knowledge;
    this.budget = input.budget;
    this.assurance = input.assurance ?? new ArtifactAssurancePipeline({ controller: input.controller, projections: input.projections, artifacts: input.artifacts, verifier: input.verifier });
  }

  wake(missionId: string): void {
    if (this.running.has(missionId)) {
      this.rerunRequested.add(missionId);
      return;
    }
    const task = this.runUntilQuiescent(missionId).finally(() => {
      this.running.delete(missionId);
      if (this.rerunRequested.delete(missionId)) this.wake(missionId);
    });
    this.running.set(missionId, task);
  }

  async whenIdle(missionId: string): Promise<void> {
    await this.running.get(missionId);
  }

  async cancelWorkItems(missionId: string, workItemIds: string[]): Promise<string[]> {
    if (!this.executionRouter) return [];
    const targets = [...this.activeExecutions.values()].filter(item => item.missionId === missionId && workItemIds.includes(item.workItemId));
    const cancelled: string[] = [];
    for (const target of targets) {
      await this.controller.emit(missionId, "execution.cancel.requested", { id: target.executionId, reason: "user steering invalidated work" }, { type: "controller" }, `steering-cancel:${target.executionId}`);
      if (await this.executionRouter.cancel(target.executionId)) cancelled.push(target.executionId);
    }
    return cancelled;
  }

  async runUntilQuiescent(missionId: string): Promise<void> {
    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {
      await this.knowledge?.scanFreshness(missionId);
      const beforeCycle = await this.controller.state(missionId);
      if (beforeCycle.status === "budget_exhausted") return;
      await this.controller.runControllerCycle({ missionId, trigger: cycle === 0 ? "manual" : "execution_event" });
      const state = await this.controller.state(missionId);
      if (["completed", "cancelled", "failed", "blocked", "plateau", "budget_exhausted"].includes(state.status)) return;

      const budgetAssessment = this.budget ? await this.budget.assess(missionId) : undefined;
      if (budgetAssessment && this.budget) {
        await this.budget.emitWarnings(budgetAssessment);
        if (this.budget.isGloballyExhausted(budgetAssessment)) {
          await this.budget.markExhausted(budgetAssessment);
          return;
        }
      }

      const allReady = (await this.projections.listWorkItems(missionId))
        .filter(work => work.status === "ready")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      if (allReady.length === 0) return;
      const dependencyArtifacts = await this.projections.listArtifacts(missionId);
      const ready = allReady.filter(work => artifactDependenciesSatisfied(work, dependencyArtifacts));
      if (ready.length === 0) return;
      const maxDispatch = budgetAssessment && this.budget
        ? this.budget.effectiveConcurrency(this.maxConcurrency, budgetAssessment)
        : this.maxConcurrency;
      const reservation = this.budget?.emptyReservation();
      const budgetBlockedMetrics = new Set<import("../../core/domain/budget.ts").BudgetMetric>();
      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[]; route?: ExecutionRoute }> = [];
      for (const work of ready) {
        if (dispatchable.length >= maxDispatch) break;
        if (work.purpose === "acquisition") {
          if (budgetAssessment && this.budget && reservation && !this.budget.canReserve(work, budgetAssessment, reservation)) {
            this.budget.exhaustedMetricsForBlockedWork(work, budgetAssessment).forEach(metric => budgetBlockedMetrics.add(metric));
            continue;
          }
          if (this.budget && reservation) this.budget.reserve(work, reservation);
          dispatchable.push({ work, capabilities: [] });
          continue;
        }
        const preparation = this.capabilityCoordinator ? await this.capabilityCoordinator.prepare(work) : { status: "ready" as const, capabilities: [], missingNeeds: [] };
        if (preparation.status !== "ready") continue;
        const route = this.executionRouter?.select(work, preparation.capabilities);
        if (budgetAssessment && this.budget && reservation && !this.budget.canReserve(work, budgetAssessment, reservation, route)) {
          this.budget.exhaustedMetricsForBlockedWork(work, budgetAssessment, route).forEach(metric => budgetBlockedMetrics.add(metric));
          continue;
        }
        if (this.budget && reservation) this.budget.reserve(work, reservation, route);
        dispatchable.push({ work, capabilities: preparation.capabilities, route });
      }
      if (dispatchable.length === 0) {
        if (budgetAssessment && this.budget && budgetBlockedMetrics.size > 0) {
          await this.budget.markExhausted(budgetAssessment, [...budgetBlockedMetrics]);
          return;
        }
        continue;
      }
      await Promise.all(dispatchable.map(item => this.executeWork(item.work, item.capabilities, item.route)));
    }
    await this.controller.emit(missionId, "mission.status.changed", { status: "plateau", reason: "orchestrator cycle budget exhausted" }, { type: "system" }, `plateau:cycle-budget:${missionId}`);
  }

  private async executeWork(work: WorkItem, capabilities: CapabilityDescriptor[] = [], reservedRoute?: ExecutionRoute): Promise<void> {
    if (work.purpose === "acquisition") {
      await this.executeAcquisitionWork(work);
      return;
    }
    const state = await this.controller.state(work.missionId);
    const attemptId = `attempt-${work.id}-${randomUUID().slice(0, 8)}`;
    const executionId = `execution-${work.id}-${randomUUID().slice(0, 8)}`;
    const workspace = this.workspaces.allocate(work.missionId, attemptId);
    const [requirements, knownArtifacts, knownSources, knownTruths, knownGaps] = await Promise.all([
      this.projections.listRequirements(work.missionId),
      this.projections.listArtifacts(work.missionId),
      this.projections.listSources(work.missionId),
      this.projections.listTruths(work.missionId),
      this.projections.listGaps(work.missionId)
    ]);
    const knowledgeContext = this.knowledgeSelector.select({ workItem: work, truths: knownTruths, sources: knownSources, gaps: knownGaps });
    const contextPacket = this.contextCompiler.compile({
      state,
      workItem: work,
      requirementRefs: work.requirementRefs,
      truthRefs: knowledgeContext.truths.map(truth => truth.id),
      sourceRefs: knowledgeContext.sources.map(source => source.id),
      artifactRefs: knownArtifacts.map(a => `${a.id}@${a.version}`),
      capabilityRefs: capabilities.map(capability => capability.id)
    });
    const workerContext = {
      contextPacket,
      requirements: requirements.filter(r => work.requirementRefs.includes(r.id)),
      truths: knowledgeContext.truths,
      sources: knowledgeContext.sources,
      gaps: knowledgeContext.relatedGaps,
      invalidatedKnowledge: { truths: knowledgeContext.diagnosticTruths, sources: knowledgeContext.diagnosticSources },
      expectedOutputs: work.expectedOutputs,
      capabilities,
      workspaceRoot: workspace.root,
      outputProtocol: workerProtocolInstruction(workspace.root)
    };

    const selectedRoute: ExecutionRoute = reservedRoute ?? this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", cancellable: true, sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }, resourceRequest: {}, requiresApproval: false };
    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: selectedRoute.kind, contextPacketId: contextPacket.id }, { type: "controller" }, `attempt:${attemptId}`);
    await this.controller.emit(work.missionId, "work.started", { id: work.id }, { type: "controller" }, `work-started:${work.id}:${attemptId}`);
    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, executorType: selectedRoute.kind, routeReason: selectedRoute.reason }, { type: "controller" }, `execution-created:${executionId}`);
    await this.controller.emit(work.missionId, "execution.route.selected", { executionId, workItemId: work.id, attemptId, route: selectedRoute.kind, reason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id), targetRef: selectedRoute.capability?.id }, { type: "controller" }, `execution-route:${executionId}`);

    const request: HostAgentExecutionRequest = {
      executionId,
      missionId: work.missionId,
      workItemId: work.id,
      attemptId,
      executor: { id: "host-agent", type: "host_agent" },
      contextPacketId: contextPacket.id,
      context: workerContext,
      inputArtifactRefs: work.inputArtifactRefs,
      expectedOutputs: work.expectedOutputs,
      capabilityRefs: capabilities.map(capability => capability.id),
      workspaceRoot: workspace.root,
      workspacePolicy: { type: "filesystem", lifecycle: "ephemeral" },
      isolationPolicy: { level: "host", networkIsolation: false, filesystemIsolation: false, processIsolation: false, secretIsolation: true },
      permissionEnvelope: { filesystemRead: [workspace.root], filesystemWrite: [workspace.root], network: "allow", networkHosts: [], allowedEnvKeys: [], subprocess: true, packageInstall: false, secrets: "deny", hostMutation: false },
      timeoutPolicy: { hardTimeoutMs: 30 * 60 * 1000 },
      retryPolicy: { runtimeRetries: 0 },
      sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true },
      preferredExecutorRefs: work.assignedExecutorId ? [work.assignedExecutorId] : undefined,
      excludeExecutorRefs: work.executionConstraints?.excludeExecutorRefs,
      forceFreshAgent: work.executionConstraints?.forceFreshAgent
    };

    this.activeExecutions.set(executionId, { missionId: work.missionId, workItemId: work.id, executionId });
    try {
      await this.controller.emit(work.missionId, "execution.started", { id: executionId, executorType: selectedRoute.kind }, { type: "host" }, `execution-started:${executionId}`);
      let result;
      let approvalRef: string | undefined;
      if (this.executionRouter) {
        const routed = await this.executionRouter.execute({ work, capabilities, baseRequest: request, route: selectedRoute });
        result = routed.result;
        approvalRef = routed.approvalRef;
      } else {
        const handle = await this.hostBackend.allocate(request);
        await this.hostBackend.start(handle);
        result = await this.hostBackend.collect(handle);
      }
      const envelope = parseWorkerOutput(result.runtimeObservationRef);
      writeExecutionRecoveryManifest(workspace.root, {
        schemaVersion: 1, missionId: work.missionId, workItemId: work.id, attemptId, executionId,
        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),
        targetRef: result.executorRef ?? selectedRoute.capability?.id, approvalRef, result: result.state, sideEffects: result.sideEffects, envelope,
        startedAt: result.startedAt, endedAt: result.endedAt, writtenAt: new Date().toISOString()
      });
      const receipt: InvocationReceipt = {
        id: `invocation-${executionId}`,
        missionId: work.missionId, workItemId: work.id, attemptId, executionId,
        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),
        targetRef: result.executorRef ?? selectedRoute.capability?.id, idempotencyKey: `${work.missionId}:${work.id}:${attemptId}`, approvalRef,
        sideEffects: result.sideEffects, result: result.state, startedAt: result.startedAt, endedAt: result.endedAt, createdAt: new Date().toISOString()
      };
      await this.controller.emit(work.missionId, "execution.invocation.recorded", { receipt }, { type: "system" }, `invocation:${executionId}`);
      const settledEvent = result.state === "succeeded" ? "execution.completed" : result.state === "cancelled" ? "execution.cancelled" : "execution.failed";
      await this.controller.emit(work.missionId, settledEvent, { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);
      if (result.state === "cancelled") {
        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "cancelled", reason: "Execution cancelled" }, { type: "controller" }, `attempt-completed:${attemptId}`);
        await this.controller.emit(work.missionId, "work.updated", { id: work.id, status: "waiting", reason: "Execution cancelled; awaiting reschedule or user direction" }, { type: "controller" }, `work-cancelled:${work.id}:${attemptId}`);
        return;
      }
      if (await this.isWorkInvalidated(work.missionId, work.id)) {
        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "cancelled", reason: "Result superseded by user steering" }, { type: "controller" }, `attempt-completed:${attemptId}`);
        return;
      }
      if (result.state !== "succeeded" || envelope?.status === "failed") {
        await this.failWork(work, attemptId, envelope?.summary ?? `Host execution ended as ${result.state}`);
        return;
      }
      const outcome = await this.assurance.process(work, attemptId, workspace.root, envelope);
      if (!outcome.ok) {
        await this.failWork(work, attemptId, outcome.reason, false);
        return;
      }
      await this.knowledgeIngestor?.ingest({ work, attemptId, envelope, artifactRefs: outcome.artifactRefs });
      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: envelope?.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs }, { type: "worker" }, `attempt-completed:${attemptId}`);
      await this.controller.emit(work.missionId, "work.completed", { id: work.id, summary: envelope?.summary ?? "Work completed", artifactRefs: outcome.artifactRefs }, { type: "worker" }, `work-completed:${work.id}:${attemptId}`);
      if (work.purpose === "repair" && outcome.artifactRefs.length > 0) {
        for (const gapId of work.gapRefs) await this.controller.resolveGap(work.missionId, gapId);
      }
      await this.promoteProposedWork(work, envelope);
    } catch (error) {
      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: error instanceof Error ? error.message : String(error) }, { type: "host" }, `execution-settled:${executionId}`);
      if (!(await this.isWorkInvalidated(work.missionId, work.id))) await this.failWork(work, attemptId, error instanceof Error ? error.message : String(error));
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  private async isWorkInvalidated(missionId: string, workId: string): Promise<boolean> {
    const work = (await this.projections.listWorkItems(missionId)).find(item => item.id === workId);
    return work?.status === "invalidated" || work?.status === "superseded" || work?.status === "abandoned";
  }

  private async executeAcquisitionWork(work: WorkItem): Promise<void> {
    const attemptId = `attempt-${work.id}-${randomUUID().slice(0, 8)}`;
    const executionId = `execution-${work.id}-${randomUUID().slice(0, 8)}`;
    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: "capability-acquisition", contextPacketId: "internal" }, { type: "controller" }, `attempt:${attemptId}`);
    await this.controller.emit(work.missionId, "work.started", { id: work.id }, { type: "controller" }, `work-started:${work.id}:${attemptId}`);
    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, backend: "capability-acquisition" }, { type: "controller" }, `execution-created:${executionId}`);
    await this.controller.emit(work.missionId, "execution.started", { id: executionId }, { type: "system" }, `execution-started:${executionId}`);
    if (!this.capabilityCoordinator) {
      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: "Capability acquisition service is not configured" }, { type: "system" }, `execution-settled:${executionId}`);
      await this.failWork(work, attemptId, "Capability acquisition service is not configured");
      return;
    }
    const outcome = await this.capabilityCoordinator.executeAcquisition(work);
    if (!outcome.ok) {
      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: outcome.reason }, { type: "system" }, `execution-settled:${executionId}`);
      await this.failWork(work, attemptId, outcome.reason);
      return;
    }
    await this.controller.emit(work.missionId, "execution.completed", { id: executionId, capabilityRef: outcome.capability?.id }, { type: "system" }, `execution-settled:${executionId}`);
    await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "succeeded", capabilityRefs: outcome.capability ? [outcome.capability.id] : [] }, { type: "system" }, `attempt-completed:${attemptId}`);
    await this.controller.emit(work.missionId, "work.completed", { id: work.id, summary: outcome.reason }, { type: "system" }, `work-completed:${work.id}:${attemptId}`);
  }

  private async failWork(work: WorkItem, attemptId: string, reason: string, openRuntimeGap = true): Promise<void> {
    await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "failed", reason }, { type: "worker" }, `attempt-completed:${attemptId}`);
    await this.controller.emit(work.missionId, "work.failed", { id: work.id, reason }, { type: "worker" }, `work-failed:${work.id}:${attemptId}`);
    if (openRuntimeGap) await this.assurance.openGap(work, `execution-${attemptId}`, reason, "runtime");
  }

  private async promoteProposedWork(parent: WorkItem, envelope: WorkerOutputEnvelope | null): Promise<void> {
    if (!envelope) return;
    const now = new Date().toISOString();
    for (let index = 0; index < envelope.proposedWork.length; index++) {
      const proposal = envelope.proposedWork[index] as any;
      if (typeof proposal.objective !== "string" || !proposal.objective.trim()) continue;
      const requirementRefs = Array.isArray(proposal.requirementRefs) ? proposal.requirementRefs.filter((x: unknown): x is string => typeof x === "string") : [];
      const gapRefs = Array.isArray(proposal.gapRefs) ? proposal.gapRefs.filter((x: unknown): x is string => typeof x === "string") : [];
      if (requirementRefs.length === 0 && gapRefs.length === 0) continue;
      await this.controller.proposeWork({
        id: `proposal-${parent.id}-${index + 1}-${randomUUID().slice(0, 6)}`,
        missionId: parent.missionId,
        workstreamId: parent.workstreamId,
        parentWorkItemId: parent.id,
        purpose: "production",
        objective: proposal.objective.trim(),
        status: "ready",
        requirementRefs,
        gapRefs,
        inputArtifactRefs: [],
        expectedOutputs: [],
        localAcceptanceCriteria: [],
        capabilityNeedRefs: [],
        priority: Math.max(0, parent.priority - 5),
        graphRevision: parent.graphRevision,
        createdBy: "worker",
        createdAt: now,
        updatedAt: now
      });
    }
  }
}

function artifactDependenciesSatisfied(work: WorkItem, artifacts: Artifact[]): boolean {
  const dependencies = work.artifactDependencies ?? [];
  if (dependencies.length === 0) return true;
  return dependencies.every(dependency => {
    const matches = artifacts.filter(artifact => artifact.logicalName === dependency.logicalName
      && (!dependency.type || artifact.type === dependency.type)
      && !["invalid", "superseded"].includes(artifact.status));
    if (matches.length === 0) return false;
    const latest = matches.sort((a, b) => b.version - a.version)[0]!;
    return artifactStatusMeets(latest.status, dependency.minimumStatus ?? "verified");
  });
}

function artifactStatusMeets(status: Artifact["status"], minimum: "candidate" | "verified" | "final"): boolean {
  const rank: Record<Artifact["status"], number> = { working: 0, candidate: 1, verified: 2, integrated: 3, final: 4, invalid: -1, superseded: -1 };
  const required = minimum === "candidate" ? 1 : minimum === "verified" ? 2 : 4;
  return rank[status] >= required;
}
