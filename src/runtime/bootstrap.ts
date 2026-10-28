import { resolve } from "node:path";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";
import { DeepSeekHarnessAdapter } from "../hosts/deepseek/deepseek-host-adapter.ts";
import { DeepSeekAcpProcessBindings } from "../hosts/deepseek/acp-process-bindings.ts";
import { MissionDatabase } from "../persistence/sqlite/database.ts";
import { SqliteEventStore } from "../persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionCatalog } from "../persistence/sqlite/sqlite-mission-catalog.ts";
import { SqliteMissionReader } from "../persistence/sqlite/sqlite-mission-reader.ts";
import { MissionController } from "../core/mission/controller.ts";
import { ExecutorRouter } from "../core/execution/executor-router.ts";
import { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
import type { CapabilityRuntime } from "../core/capabilities/capability-coordinator.ts";
import { FileArtifactStore } from "../execution/artifacts/artifact-store.ts";
import { HostAgentWorkExecutionDriver } from "../execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../execution/workspace/workspace-manager.ts";
import { RuntimeApprovalManager } from "./approval-manager.ts";
import { MissionAgentSkillWorkspaceProjector } from "./agent-skill-runtime.ts";
import { CapabilityWorkspaceHostAdapter } from "./capability-context-host-adapter.ts";
import { HostAgentJsonTransport } from "./host-agent-json-transport.ts";
import { HostArtifactVerifier } from "./host-artifact-verifier.ts";
import { HostCapabilityRuntime } from "./host-capability-runtime.ts";
import { HostDeliberationProvider } from "./host-deliberation-provider.ts";
import { MissionSupervisor } from "./mission-supervisor.ts";
import { createProductionAgentSkillCapabilityRuntime } from "./production-capability-runtime.ts";
import {
  TrustedMcpHostAdapter,
  TrustedMcpRegistry,
  parseTrustedMcpServersJson,
  type TrustedMcpServerConfig
} from "./trusted-mcp-runtime.ts";

export interface ProductionCapabilityAcquisitionOptions {
  mode: "github-skills";
  isolation: "docker";
  githubToken?: string;
  dockerImage: string;
  dockerBinary?: string;
  githubRequestTimeoutMs?: number;
  maxCandidates?: number;
}

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
  capabilityAcquisition?: ProductionCapabilityAcquisitionOptions;
  trustedMcpServers?: TrustedMcpServerConfig[];
  allowInsecureTrustedMcpHttp?: boolean;
}

export interface MissionRuntime {
  database: MissionDatabase;
  events: SqliteEventStore;
  catalog: SqliteMissionCatalog;
  reader: SqliteMissionReader;
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
  const reader = new SqliteMissionReader(database);
  const approvals = new RuntimeApprovalManager(events, { timeoutMs: options.approvalTimeoutMs });

  const baseHost = options.host ?? new DeepSeekHarnessAdapter(new DeepSeekAcpProcessBindings({
    binary: options.dshBinary,
    argsPrefix: options.dshArgsPrefix,
    approvalHandler: request => approvals.requestHostApproval(request)
  }));
  const trustedMcp = new TrustedMcpRegistry(options.trustedMcpServers ?? [], {
    allowInsecureHttp: options.allowInsecureTrustedMcpHttp
  });
  const mcpHost = new TrustedMcpHostAdapter(baseHost, trustedMcp);
  const overlay = new MissionCapabilityOverlay();
  const skillProjection = new MissionAgentSkillWorkspaceProjector(overlay);
  const host = new CapabilityWorkspaceHostAdapter(mcpHost, skillProjection);

  const executorId = options.executorId?.trim() || "deepseek-host";
  const controlTransport = new HostAgentJsonTransport(host, {
    workspaceRoot: resolve(root, "control"),
    hardTimeoutMs: options.controlTimeoutMs,
    retainWorkspaces: options.retainControlWorkspaces
  });
  const deliberation = new HostDeliberationProvider({
    transport: controlTransport,
    events,
    reader,
    host,
    knownExecutorIds: [executorId],
    defaultExecutorId: executorId
  });
  const verifier = new HostArtifactVerifier({ transport: controlTransport, events, reader });
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
  const capabilities = createCapabilityRuntime({
    root,
    host,
    overlay,
    approvals,
    acquisition: options.capabilityAcquisition
  });
  const controller = new MissionController(events, deliberation, execution, verifier, capabilities, reader);
  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: options.maxSupervisorCycles });

  return {
    database,
    events,
    catalog,
    reader,
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
  const allowInsecureTrustedMcpHttp = env.MISSION_TRUSTED_MCP_ALLOW_HTTP === "1";
  const trustedMcpServers = parseTrustedMcpServersJson(env.MISSION_TRUSTED_MCP_SERVERS_JSON, {
    allowInsecureHttp: allowInsecureTrustedMcpHttp
  });
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
    retainControlWorkspaces: env.MISSION_RETAIN_CONTROL_WORKSPACES === "1",
    capabilityAcquisition: capabilityAcquisitionFromEnv(env),
    trustedMcpServers,
    allowInsecureTrustedMcpHttp
  });
}

function createCapabilityRuntime(input: {
  root: string;
  host: HostAdapter;
  overlay: MissionCapabilityOverlay;
  approvals: RuntimeApprovalManager;
  acquisition?: ProductionCapabilityAcquisitionOptions;
}): CapabilityRuntime {
  if (!input.acquisition) return new HostCapabilityRuntime(input.host, input.overlay);
  return createProductionAgentSkillCapabilityRuntime({
    rootDir: resolve(input.root, "capabilities"),
    host: input.host,
    overlay: input.overlay,
    approvals: input.approvals,
    githubToken: input.acquisition.githubToken,
    dockerImage: input.acquisition.dockerImage,
    dockerBinary: input.acquisition.dockerBinary,
    githubRequestTimeoutMs: input.acquisition.githubRequestTimeoutMs,
    maxCandidates: input.acquisition.maxCandidates
  });
}

function capabilityAcquisitionFromEnv(env: NodeJS.ProcessEnv): ProductionCapabilityAcquisitionOptions | undefined {
  const mode = env.MISSION_CAPABILITY_ACQUISITION?.trim();
  if (!mode || mode === "disabled") return undefined;
  if (mode !== "github-skills") throw new Error(`Unsupported MISSION_CAPABILITY_ACQUISITION mode: ${mode}`);
  const isolation = env.MISSION_CAPABILITY_ISOLATION?.trim();
  if (isolation !== "docker") {
    throw new Error(
      "MISSION_CAPABILITY_ACQUISITION=github-skills requires MISSION_CAPABILITY_ISOLATION=docker; external capability code is never smoke-tested with host/process-only isolation"
    );
  }
  return {
    mode: "github-skills",
    isolation: "docker",
    githubToken: env.MISSION_GITHUB_TOKEN?.trim() || env.GITHUB_TOKEN?.trim() || undefined,
    dockerImage: env.MISSION_CAPABILITY_DOCKER_IMAGE?.trim() || "alpine:3.20",
    dockerBinary: env.MISSION_CAPABILITY_DOCKER_BINARY?.trim() || undefined,
    githubRequestTimeoutMs: positiveNumber(env.MISSION_GITHUB_TIMEOUT_MS),
    maxCandidates: positiveNumber(env.MISSION_CAPABILITY_MAX_CANDIDATES)
  };
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
