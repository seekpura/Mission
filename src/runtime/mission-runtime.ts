import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliberationProvider } from "../core/planning/deliberation-provider.ts";
import { MissionController } from "../core/mission/controller.ts";
import { MissionDatabase } from "../persistence/sqlite/database.ts";
import { SqliteEventStore } from "../persistence/sqlite/sqlite-event-store.ts";
import { SqliteProjectionStore } from "../persistence/sqlite/sqlite-projection-store.ts";
import { SnapshotStore } from "../persistence/sqlite/snapshot-store.ts";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";
import { HostAgentExecutionBackend } from "../execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../execution/local/local-execution-backend.ts";
import { WorkExecutionRouter } from "./orchestration/executor-router.ts";
import { ExecutionRecoveryManager } from "./recovery/execution-recovery-manager.ts";
import { WorkspaceManager } from "../execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../execution/artifacts/artifact-store.ts";
import { VerificationPlanner } from "../core/verification/verification-planner.ts";
import { VerifierRegistry } from "../core/verification/verifier-registry.ts";
import { DeterministicFileCheckExecutor } from "../core/verification/deterministic-file-check-executor.ts";
import { HostReviewCheckExecutor } from "../core/verification/host-review-check-executor.ts";
import { RuntimeCommandCheckExecutor } from "../core/verification/runtime-command-check-executor.ts";
import { IntegrationCheckExecutor } from "../core/verification/integration-check-executor.ts";
import { ProfiledVerifier } from "../core/verification/profiled-verifier.ts";
import { InspectionProviderRegistry } from "../core/inspection/inspection-registry.ts";
import type { InspectionProvider } from "../core/inspection/inspection-provider.ts";
import { CapabilityBackedInspectionProvider } from "../core/inspection/capability-backed-inspection-provider.ts";
import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";
import { ArtifactAssurancePipeline } from "./orchestration/artifact-assurance-pipeline.ts";
import { ArtifactInspectionService } from "./orchestration/artifact-inspection-service.ts";
import { CapabilityCoordinator } from "./orchestration/capability-coordinator.ts";
import { VerificationContinuationService } from "./orchestration/verification-continuation-service.ts";
import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";

export interface MissionRuntimeOptions {
  dbPath?: string;
  schemaPath?: string;
  rootDir?: string;
  deliberation?: DeliberationProvider;
  host?: HostAdapter;
  maxConcurrency?: number;
  acquisition?: SecureAcquisitionService;
  inspectionProviders?: InspectionProvider[];
}

export class MissionRuntime {
  readonly database: MissionDatabase;
  readonly projections: SqliteProjectionStore;
  readonly events: SqliteEventStore;
  readonly snapshots: SnapshotStore;
  readonly controller: MissionController;
  readonly workspaces: WorkspaceManager;
  readonly artifacts: FileArtifactStore;
  readonly orchestrator?: MissionOrchestrator;
  readonly executionRouter?: WorkExecutionRouter;
  readonly recovery?: ExecutionRecoveryManager;
  readonly inspection?: ArtifactInspectionService;

  constructor(options: MissionRuntimeOptions = {}) {
    const rootDir = options.rootDir ?? join(process.cwd(), ".mission");
    const dbPath = options.dbPath ?? join(rootDir, "mission.db");
    const schemaPath = options.schemaPath ?? fileURLToPath(new URL("../persistence/sqlite/schema.sql", import.meta.url));
    this.database = new MissionDatabase(dbPath);
    this.database.migrate(schemaPath);
    this.projections = new SqliteProjectionStore(this.database);
    this.events = new SqliteEventStore(this.database, this.projections);
    this.snapshots = new SnapshotStore(this.database);
    this.controller = new MissionController(this.events, {
      projections: this.projections,
      deliberation: options.deliberation
    });
    this.workspaces = new WorkspaceManager(rootDir);
    this.artifacts = new FileArtifactStore(rootDir);
    if (options.host) {
      const hostAgentBackend = new HostAgentExecutionBackend(options.host);
      const executionRouter = new WorkExecutionRouter({
        host: options.host,
        agents: hostAgentBackend,
        hostCapabilities: new HostCapabilityExecutionBackend(options.host),
        local: new LocalExecutionBackend(this.workspaces, this.artifacts),
        audit: {
          approvalRequested: payload => this.controller.emit(payload.missionId, "approval.requested", payload, { type: "controller" }, `approval-request:${payload.id}`),
          approvalDecided: payload => this.controller.emit(payload.missionId, "approval.decided", payload, { type: "user" }, `approval-decision:${payload.id}`)
        }
      });
      const registry = new VerifierRegistry([new DeterministicFileCheckExecutor(), new RuntimeCommandCheckExecutor(), new IntegrationCheckExecutor(), new HostReviewCheckExecutor(options.host)]);
      const verifier = new ProfiledVerifier(new VerificationPlanner(), registry);
      const inspectionProviders = [
        ...(options.inspectionProviders ?? []),
        new CapabilityBackedInspectionProvider({ host: options.host, projections: this.projections })
      ];
      const inspection = new ArtifactInspectionService({
        controller: this.controller,
        artifacts: this.artifacts,
        workspaces: this.workspaces,
        registry: new InspectionProviderRegistry(inspectionProviders)
      });
      const assurance = new ArtifactAssurancePipeline({ controller: this.controller, projections: this.projections, artifacts: this.artifacts, verifier, inspectionService: inspection });
      const verificationContinuation = new VerificationContinuationService({ controller: this.controller, assurance });
      this.executionRouter = executionRouter;
      this.inspection = inspection;
      this.recovery = new ExecutionRecoveryManager({ controller: this.controller, events: this.events, projections: this.projections, router: executionRouter, workspaces: this.workspaces, assurance });
      this.orchestrator = new MissionOrchestrator({
        controller: this.controller,
        projections: this.projections,
        hostBackend: hostAgentBackend,
        workspaces: this.workspaces,
        artifacts: this.artifacts,
        verifier,
        assurance,
        capabilityCoordinator: new CapabilityCoordinator({
          controller: this.controller,
          projections: this.projections,
          host: options.host,
          acquisition: options.acquisition,
          verificationContinuation
        }),
        executionRouter,
        options: { maxConcurrency: options.maxConcurrency }
      });
    }
  }

  async checkpoint(missionId: string): Promise<void> {
    this.snapshots.save(await this.controller.state(missionId));
  }

  async rebuildProjection(missionId: string): Promise<void> {
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.projections.rebuild(missionId, await this.events.list(missionId));
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  async steer(missionId: string, message: string) {
    const result = await this.controller.steerWithImpact(missionId, message);
    if (result.impact.invalidatedWorkItemRefs.length > 0) {
      await this.orchestrator?.cancelWorkItems(missionId, result.impact.invalidatedWorkItemRefs);
    }
    await this.controller.runControllerCycle({ missionId, trigger: "user_steering" });
    this.orchestrator?.wake(missionId);
    return result;
  }

  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {
    if (!this.executionRouter) return false;
    await this.controller.emit(missionId, "execution.cancel.requested", { id: executionId }, { type: "user" }, `execution-cancel-request:${executionId}`);
    return this.executionRouter.cancel(executionId);
  }

  async recoverMission(missionId: string) {
    if (!this.recovery) return { running: [], recovered: [], lost: [] };
    return this.recovery.reconcileMission(missionId);
  }

  close(): void { this.database.close(); }
}
