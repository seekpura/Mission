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
import { WorkspaceManager } from "../execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../execution/artifacts/artifact-store.ts";
import { BasicFileVerifier } from "../core/verification/basic-file-verifier.ts";
import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";
import { CapabilityCoordinator } from "./orchestration/capability-coordinator.ts";
import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";

export interface MissionRuntimeOptions {
  dbPath?: string;
  schemaPath?: string;
  rootDir?: string;
  deliberation?: DeliberationProvider;
  host?: HostAdapter;
  maxConcurrency?: number;
  acquisition?: SecureAcquisitionService;
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
      this.orchestrator = new MissionOrchestrator({
        controller: this.controller,
        projections: this.projections,
        hostBackend: hostAgentBackend,
        workspaces: this.workspaces,
        artifacts: this.artifacts,
        verifier: new BasicFileVerifier(),
        capabilityCoordinator: new CapabilityCoordinator({ controller: this.controller, projections: this.projections, host: options.host, acquisition: options.acquisition }),
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

  close(): void { this.database.close(); }
}
