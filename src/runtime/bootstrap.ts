import { resolve } from "node:path";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";
import { DeepSeekHarnessAdapter } from "../hosts/deepseek/deepseek-host-adapter.ts";
import { DeepSeekAcpProcessBindings } from "../hosts/deepseek/acp-process-bindings.ts";
import { MissionDatabase } from "../persistence/sqlite/database.ts";
import { SqliteEventStore } from "../persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionCatalog } from "../persistence/sqlite/sqlite-mission-catalog.ts";
import { MissionController } from "../core/mission/controller.ts";
import { ExecutorRouter } from "../core/execution/executor-router.ts";
import { FileArtifactStore } from "../execution/artifacts/artifact-store.ts";
import { HostAgentWorkExecutionDriver } from "../execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../execution/workspace/workspace-manager.ts";
import { RuntimeApprovalManager } from "./approval-manager.ts";
import { HostAgentJsonTransport } from "./host-agent-json-transport.ts";
import { HostArtifactVerifier } from "./host-artifact-verifier.ts";
import { HostCapabilityRuntime } from "./host-capability-runtime.ts";
import { HostDeliberationProvider } from "./host-deliberation-provider.ts";
import { MissionSupervisor } from "./mission-supervisor.ts";

export interface MissionRuntimeOptions {
  rootDir: string;
  schemaPath: string;
  dbPath?: string;
  host?: HostAdapter;
  dshBinary?: string;
  dshArgsPrefix?: string[];
  executorId?: string;
  approvalTimeoutMs?: number;
  controlTimeoutMs?: number;
  workTimeoutMs?: number;
  maxSupervisorCycles?: number;
  retainControlWorkspaces?: boolean;
}

export interface MissionRuntime {
  database: MissionDatabase;
  events: SqliteEventStore;
  catalog: SqliteMissionCatalog;
  host: HostAdapter;
  approvals: RuntimeApprovalManager;
  controller: MissionController;
  supervisor: MissionSupervisor;
  recoverExistingMissions(): Promise<string[]>;
  close(): void;
}

export function createMissionRuntime(options: MissionRuntimeOptions): MissionRuntime {
  const root = resolve(options.rootDir);
  const database = new MissionDatabase(options.dbPath ?? resolve(root, "mission.db"));
  database.migrate(resolve(options.schemaPath));
  const events = new SqliteEventStore(database);
  const catalog = new SqliteMissionCatalog(database);
  const approvals = new RuntimeApprovalManager(events, { timeoutMs: options.approvalTimeoutMs });

  const host = options.host ?? new DeepSeekHarnessAdapter(new DeepSeekAcpProcessBindings({
    binary: options.dshBinary,
    argsPrefix: options.dshArgsPrefix,
    approvalHandler: request => approvals.requestHostApproval(request)
  }));

  const executorId = options.executorId?.trim() || "deepseek-host";
  const controlTransport = new HostAgentJsonTransport(host, {
    workspaceRoot: resolve(root, "control"),
    hardTimeoutMs: options.controlTimeoutMs,
    retainWorkspaces: options.retainControlWorkspaces
  });
  const deliberation = new HostDeliberationProvider({
    transport: controlTransport,
    events,
    knownExecutorIds: [executorId],
    defaultExecutorId: executorId
  });
  const verifier = new HostArtifactVerifier({ transport: controlTransport, events });
  const workDriver = new HostAgentWorkExecutionDriver(
    host,
    new WorkspaceManager(resolve(root, "workspaces")),
    new FileArtifactStore(resolve(root, "artifact-store")),
    { hardTimeoutMs: options.workTimeoutMs }
  );
  const execution = new ExecutorRouter(
    [{ executorId, driver: workDriver }],
    { defaultExecutorId: executorId }
  );
  const capabilities = new HostCapabilityRuntime(host);
  const controller = new MissionController(events, deliberation, execution, verifier, capabilities);
  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: options.maxSupervisorCycles });

  return {
    database,
    events,
    catalog,
    host,
    approvals,
    controller,
    supervisor,
    async recoverExistingMissions(): Promise<string[]> {
      const resumed: string[] = [];
      for (const missionId of await catalog.listMissionIds()) {
        await approvals.rejectStalePending(missionId);
        const state = await controller.state(missionId);
        if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") continue;
        void supervisor.wake(missionId, "manual");
        resumed.push(missionId);
      }
      return resumed;
    },
    close(): void {
      approvals.dispose();
      database.close();
    }
  };
}

export function createProductionMissionRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): MissionRuntime {
  const rootDir = env.MISSION_HOME ? resolve(env.MISSION_HOME) : resolve(cwd, ".mission");
  const dshArgsPrefix = parseStringArrayEnv(env.MISSION_DSH_ARGS_PREFIX_JSON, "MISSION_DSH_ARGS_PREFIX_JSON");
  return createMissionRuntime({
    rootDir,
    dbPath: env.MISSION_DB ? resolve(env.MISSION_DB) : resolve(rootDir, "mission.db"),
    schemaPath: resolve(cwd, "src", "persistence", "sqlite", "schema.sql"),
    dshBinary: env.MISSION_DSH_BINARY || "dsh",
    dshArgsPrefix,
    executorId: env.MISSION_EXECUTOR_ID || "deepseek-host",
    approvalTimeoutMs: positiveNumber(env.MISSION_APPROVAL_TIMEOUT_MS),
    controlTimeoutMs: positiveNumber(env.MISSION_CONTROL_TIMEOUT_MS),
    workTimeoutMs: positiveNumber(env.MISSION_WORK_TIMEOUT_MS),
    maxSupervisorCycles: positiveNumber(env.MISSION_MAX_CYCLES_PER_WAKE),
    retainControlWorkspaces: env.MISSION_RETAIN_CONTROL_WORKSPACES === "1"
  });
}

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`Expected positive numeric environment value, received: ${value}`);
  return parsed;
}

function parseStringArrayEnv(value: string | undefined, name: string): string[] | undefined {
  if (!value) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be a JSON string array: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || parsed.some(item => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return [...parsed];
}
