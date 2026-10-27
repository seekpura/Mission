import { randomUUID } from "node:crypto";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import { ContextCompiler } from "../../core/context/context-compiler.ts";
import { parseWorkerOutput, workerProtocolInstruction, type WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import { ArtifactAssurancePipeline } from "./artifact-assurance-pipeline.ts";
import { HostAgentExecutionBackend, type HostAgentExecutionRequest } from "../../execution/host/host-agent-execution-backend.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import type { FileArtifactStore } from "../../execution/artifacts/artifact-store.ts";
import type { Verifier } from "../../core/verification/verifier.ts";

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
  private readonly running = new Map<string, Promise<void>>();
  private readonly rerunRequested = new Set<string>();

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    hostBackend: HostAgentExecutionBackend;
    workspaces: WorkspaceManager;
    artifacts: FileArtifactStore;
    verifier: Verifier;
    contextCompiler?: ContextCompiler;
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
    this.assurance = new ArtifactAssurancePipeline({ controller: input.controller, projections: input.projections, artifacts: input.artifacts, verifier: input.verifier });
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

  async runUntilQuiescent(missionId: string): Promise<void> {
    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle++) {
      await this.controller.runControllerCycle({ missionId, trigger: cycle === 0 ? "manual" : "execution_event" });
      const state = await this.controller.state(missionId);
      if (["completed", "cancelled", "failed", "blocked", "plateau"].includes(state.status)) return;
      const ready = (await this.projections.listWorkItems(missionId))
        .filter(work => work.status === "ready")
        .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt));
      if (ready.length === 0) return;
      const batch = ready.slice(0, this.maxConcurrency);
      await Promise.all(batch.map(work => this.executeWork(work)));
    }
    await this.controller.emit(missionId, "mission.status.changed", { status: "plateau", reason: "orchestrator cycle budget exhausted" }, { type: "system" }, `plateau:cycle-budget:${missionId}`);
  }

  private async executeWork(work: WorkItem): Promise<void> {
    const state = await this.controller.state(work.missionId);
    const attemptId = `attempt-${work.id}-${randomUUID().slice(0, 8)}`;
    const executionId = `execution-${work.id}-${randomUUID().slice(0, 8)}`;
    const workspace = this.workspaces.allocate(work.missionId, attemptId);
    const requirements = await this.projections.listRequirements(work.missionId);
    const knownArtifacts = await this.projections.listArtifacts(work.missionId);
    const contextPacket = this.contextCompiler.compile({
      state,
      workItem: work,
      requirementRefs: work.requirementRefs,
      artifactRefs: knownArtifacts.map(a => `${a.id}@${a.version}`),
      capabilityRefs: []
    });
    const workerContext = {
      contextPacket,
      requirements: requirements.filter(r => work.requirementRefs.includes(r.id)),
      expectedOutputs: work.expectedOutputs,
      workspaceRoot: workspace.root,
      outputProtocol: workerProtocolInstruction(workspace.root)
    };

    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: "host-agent", contextPacketId: contextPacket.id }, { type: "controller" }, `attempt:${attemptId}`);
    await this.controller.emit(work.missionId, "work.started", { id: work.id }, { type: "controller" }, `work-started:${work.id}:${attemptId}`);
    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId }, { type: "controller" }, `execution-created:${executionId}`);

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
      capabilityRefs: [],
      workspaceRoot: workspace.root,
      workspacePolicy: { type: "filesystem", lifecycle: "ephemeral" },
      isolationPolicy: { level: "host", networkIsolation: false, filesystemIsolation: false, processIsolation: false, secretIsolation: true },
      permissionEnvelope: { filesystemRead: [workspace.root], filesystemWrite: [workspace.root], network: "allow", networkHosts: [], allowedEnvKeys: [], subprocess: true, packageInstall: false, secrets: "deny", hostMutation: false },
      timeoutPolicy: { hardTimeoutMs: 30 * 60 * 1000 },
      retryPolicy: { runtimeRetries: 0 },
      sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }
    };

    try {
      const handle = await this.hostBackend.allocate(request);
      await this.controller.emit(work.missionId, "execution.started", { id: executionId }, { type: "host" }, `execution-started:${executionId}`);
      await this.hostBackend.start(handle);
      const result = await this.hostBackend.collect(handle);
      await this.controller.emit(work.missionId, result.state === "succeeded" ? "execution.completed" : "execution.failed", { id: executionId, result }, { type: "host" }, `execution-settled:${executionId}`);
      const envelope = parseWorkerOutput(result.runtimeObservationRef);
      if (result.state !== "succeeded" || envelope?.status === "failed") {
        await this.failWork(work, attemptId, envelope?.summary ?? `Host execution ended as ${result.state}`);
        return;
      }
      const outcome = await this.assurance.process(work, attemptId, workspace.root, envelope);
      if (!outcome.ok) {
        await this.failWork(work, attemptId, outcome.reason);
        return;
      }
      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: envelope?.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs }, { type: "worker" }, `attempt-completed:${attemptId}`);
      await this.controller.emit(work.missionId, "work.completed", { id: work.id, summary: envelope?.summary ?? "Work completed", artifactRefs: outcome.artifactRefs }, { type: "worker" }, `work-completed:${work.id}:${attemptId}`);
      if (work.purpose === "repair" && outcome.artifactRefs.length > 0) {
        for (const gapId of work.gapRefs) await this.controller.resolveGap(work.missionId, gapId);
      }
      await this.promoteProposedWork(work, envelope);
    } catch (error) {
      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: error instanceof Error ? error.message : String(error) }, { type: "host" }, `execution-settled:${executionId}`);
      await this.failWork(work, attemptId, error instanceof Error ? error.message : String(error));
    }
  }

  private async failWork(work: WorkItem, attemptId: string, reason: string): Promise<void> {
    await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "failed", reason }, { type: "worker" }, `attempt-completed:${attemptId}`);
    await this.controller.emit(work.missionId, "work.failed", { id: work.id, reason }, { type: "worker" }, `work-failed:${work.id}:${attemptId}`);
    await this.assurance.openGap(work, `execution-${attemptId}`, reason, "runtime");
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
