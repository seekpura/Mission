import { resolve } from "node:path";
import type { HostAdapter } from "../hosts/host-adapter.ts";
import { CodexAppServerHostAdapter } from "../hosts/codex/codex-app-server-host-adapter.ts";
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
import {
  FileTrustedCapabilityCache,
  type TrustedCapabilityCache
} from "../core/capabilities/trusted-capability-cache.ts";
import type { VerificationEvidenceCollector } from "../core/verification/evidence-collector.ts";
import { FileArtifactStore } from "../execution/artifacts/artifact-store.ts";
import { HostAgentWorkExecutionDriver } from "../execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../execution/workspace/workspace-manager.ts";
import { RuntimeApprovalManager } from "./approval-manager.ts";
import { MissionAgentSkillWorkspaceProjector } from "./agent-skill-runtime.ts";
import {
  CapabilityLedgerRuntime,
  RuntimeCapabilityLifecycleManager
} from "./capability-ledger-runtime.ts";
import { CapabilityWorkspaceHostAdapter } from "./capability-context-host-adapter.ts";
import {
  createTrustedHostCapabilityEvidenceCollectors,
  parseTrustedHostCapabilityEvidenceBindingsJson,
  type TrustedHostCapabilityEvidenceBinding
} from "./host-capability-evidence-collector.ts";
import { HostAgentJsonTransport } from "./host-agent-json-transport.ts";
import { HostArtifactVerifier } from "./host-artifact-verifier.ts";
import { HostCapabilityRuntime } from "./host-capability-runtime.ts";
import { HostDeliberationProvider } from "./host-deliberation-provider.ts";
import { MissionSupervisor } from "./mission-supervisor.ts";
import { DrainableHostAdapter } from "./drainable-host-adapter.ts";
import {
  closeMissionRuntimeIfIdle,
  shutdownMissionRuntime,
  type RuntimeShutdownOptions,
  type RuntimeShutdownResult
} from "./runtime-shutdown.ts";
import { createProductionAgentSkillCapabilityRuntime } from "./production-capability-runtime.ts";
import {
  createStructuredProviderEvidenceCollectors,
  parseTrustedProviderEvidenceRoutesJson,
  type TrustedProviderEvidenceRoute
} from "./provider-evidence-collector.ts";
import { RuntimeSideEffectManager } from "./side-effect-manager.ts";
import { SideEffectHostAdapter } from "./side-effect-host-adapter.ts";
import { HostSideEffectScopeRegistry } from "./side-effect-host-scope.ts";
import {
  TrustedMcpHostAdapter,
  TrustedMcpRegistry,
  parseTrustedMcpServersJson,
  type TrustedMcpServerConfig
} from "./trusted-mcp-runtime.ts";
import { createDefaultVerificationEvidenceCollectorRegistry } from "./verification-evidence-collectors.ts";

export interface ProductionCapabilityAcquisitionOptions {
  mode: "github-skills";
  isolation: "docker";
  githubToken?: string;
  dockerImage: string;
  dockerBinary?: string;
  githubRequestTimeoutMs?: number;
  maxCandidates?: number;
}

export type ProductionHostKind = "deepseek" | "codex";

export interface MissionRuntimeOptions {
  rootDir: string;
  schemaPath: string;
  dbPath?: string;
  host?: HostAdapter;
  hostKind?: ProductionHostKind;
  dshBinary?: string;
  dshArgsPrefix?: string[];
  codexBinary?: string;
  codexArgsPrefix?: string[];
  codexModel?: string;
  executorId?: string;
  approvalTimeoutMs?: number;
  controlTimeoutMs?: number;
  workTimeoutMs?: number;
  maxSupervisorCycles?: number;
  retainControlWorkspaces?: boolean;
  capabilityAcquisition?: ProductionCapabilityAcquisitionOptions;
  trustedMcpServers?: TrustedMcpServerConfig[];
  allowInsecureTrustedMcpHttp?: boolean;
  /**
   * Provider-/deployment-specific collectors for evidence that cannot be
   * established from artifact bytes alone. These are trusted in-process
   * adapters supplied by the embedding Runtime.
   */
  verificationEvidenceCollectors?: VerificationEvidenceCollector[];
  /**
   * Production structured provider routes. Runtime owns the semantic mapping,
   * evidence type/profile/artifact scope and durable claim for each evidence
   * kind; deployment only pins a real host capability/provider/protocol.
   */
  providerEvidenceRoutes?: TrustedProviderEvidenceRoute[];
  /**
   * Explicit low-level read-only bindings from live HostAdapter capabilities
   * into typed Runtime Evidence. Kept for trusted custom integrations. No host
   * capability is auto-invoked merely because it exists in the semantic graph.
   */
  hostEvidenceCapabilities?: TrustedHostCapabilityEvidenceBinding[];
}

export interface MissionRuntime {
  database: MissionDatabase;
  events: SqliteEventStore;
  catalog: SqliteMissionCatalog;
  reader: SqliteMissionReader;
  host: HostAdapter;
  approvals: RuntimeApprovalManager;
  sideEffects: RuntimeSideEffectManager;
  capabilityLifecycle: RuntimeCapabilityLifecycleManager;
  controller: MissionController;
  supervisor: MissionSupervisor;
  recoverExistingMissions(): Promise<string[]>;
  shutdown(options?: RuntimeShutdownOptions): Promise<RuntimeShutdownResult>;
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
  const sideEffects = new RuntimeSideEffectManager(events, approvals);
  const sideEffectScopes = new HostSideEffectScopeRegistry();

  const hostKind = options.hostKind ?? "deepseek";
  if (hostKind === "codex" && options.capabilityAcquisition) {
    throw new Error(
      "Production Agent Skill acquisition is not yet deliverable through Codex app-server; refusing to project DeepSeek-native .agents/skills semantics into a different HostAdapter"
    );
  }
  if (options.host && options.capabilityAcquisition) {
    throw new Error(
      "A custom HostAdapter cannot use production Agent Skill acquisition without an explicit provider-native Skill delivery adapter"
    );
  }
  const approvalHandler = (request: Parameters<RuntimeSideEffectManager["authorizeHostPermission"]>[0]) =>
    sideEffects.authorizeHostPermission(sideEffectScopes.enrich(request));
  const baseHost = options.host ?? (hostKind === "codex"
    ? new CodexAppServerHostAdapter({
        binary: options.codexBinary,
        argsPrefix: options.codexArgsPrefix,
        model: options.codexModel,
        approvalHandler
      })
    : new DeepSeekHarnessAdapter(new DeepSeekAcpProcessBindings({
        binary: options.dshBinary,
        argsPrefix: options.dshArgsPrefix,
        approvalHandler
      })));
  const trustedMcp = new TrustedMcpRegistry(options.trustedMcpServers ?? [], {
    allowInsecureHttp: options.allowInsecureTrustedMcpHttp
  });
  const mcpHost = new TrustedMcpHostAdapter(baseHost, trustedMcp);
  const overlay = new MissionCapabilityOverlay();
  const capabilityHost = !options.host && hostKind === "deepseek"
    ? new CapabilityWorkspaceHostAdapter(mcpHost, new MissionAgentSkillWorkspaceProjector(overlay))
    : mcpHost;
  const sideEffectHost = new SideEffectHostAdapter(capabilityHost, sideEffects, { scopeRegistry: sideEffectScopes });
  const host = new DrainableHostAdapter(sideEffectHost);

  const executorId = options.executorId?.trim() || (hostKind === "codex" ? "codex-host" : "deepseek-host");
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
  const providerEvidenceCollectors = createStructuredProviderEvidenceCollectors(
    host,
    options.providerEvidenceRoutes ?? []
  );
  const hostEvidenceCollectors = createTrustedHostCapabilityEvidenceCollectors(
    host,
    options.hostEvidenceCapabilities ?? []
  );
  const verifier = new HostArtifactVerifier({
    transport: controlTransport,
    events,
    reader,
    evidenceCollectors: createDefaultVerificationEvidenceCollectorRegistry([
      ...providerEvidenceCollectors,
      ...hostEvidenceCollectors,
      ...(options.verificationEvidenceCollectors ?? [])
    ])
  });
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

  const trustedCapabilityCache: TrustedCapabilityCache | undefined = options.capabilityAcquisition
    ? new FileTrustedCapabilityCache(resolve(root, "capabilities", "trusted-cache"))
    : undefined;
  const baseCapabilities = createCapabilityRuntime({
    root,
    host,
    overlay,
    approvals,
    acquisition: options.capabilityAcquisition,
    trustedCache: trustedCapabilityCache
  });
  const capabilities = new CapabilityLedgerRuntime(baseCapabilities, events);
  const capabilityLifecycle = new RuntimeCapabilityLifecycleManager(
    capabilities,
    events,
    trustedCapabilityCache
  );
  const controller = new MissionController(events, deliberation, execution, verifier, capabilities, reader);
  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: options.maxSupervisorCycles });
  let closed = false;
  let shutdownStarted = false;
  let shutdownPromise: Promise<RuntimeShutdownResult> | undefined;
  let recoveryPromise: Promise<string[]> | undefined;
  const lifecycle = { supervisor, host, approvals, database };

  return {
    database,
    events,
    catalog,
    reader,
    host,
    approvals,
    sideEffects,
    capabilityLifecycle,
    controller,
    supervisor,
    recoverExistingMissions(): Promise<string[]> {
      if (shutdownStarted || closed) return Promise.resolve([]);
      if (recoveryPromise) return recoveryPromise;
      recoveryPromise = (async () => {
        const resumed: string[] = [];
        for (const missionId of await catalog.listMissionIds()) {
          if (shutdownStarted) break;
          await approvals.rejectStalePending(missionId);
          const state = await controller.state(missionId);
          if (state.status === "completed" || state.status === "cancelled" || state.status === "failed") continue;
          if (shutdownStarted) break;
          void supervisor.wake(missionId, "manual");
          resumed.push(missionId);
        }
        return resumed;
      })().finally(() => {
        recoveryPromise = undefined;
      });
      return recoveryPromise;
    },
    shutdown(shutdownOptions: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownResult> {
      if (closed) {
        return Promise.resolve({ forced: false, cancelledHandleIds: [], cancellationFailures: [] });
      }
      if (shutdownPromise) return shutdownPromise;
      shutdownStarted = true;
      shutdownPromise = (async () => {
        if (recoveryPromise) await recoveryPromise;
        return shutdownMissionRuntime(lifecycle, shutdownOptions);
      })()
        .then(result => {
          closed = true;
          return result;
        })
        .catch(error => {
          shutdownPromise = undefined;
          throw error;
        });
      return shutdownPromise;
    },
    close(): void {
      if (closed) return;
      if (shutdownPromise) throw new Error("Cannot synchronously close Mission Runtime while asynchronous shutdown is in progress");
      shutdownStarted = true;
      if (recoveryPromise) throw new Error("Cannot synchronously close Mission Runtime while startup recovery is active");
      closeMissionRuntimeIfIdle(lifecycle);
      closed = true;
    }
  };
}

export function createProductionMissionRuntimeFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): MissionRuntime {
  const rootDir = env.MISSION_HOME ? resolve(env.MISSION_HOME) : resolve(cwd, ".mission");
  const hostKind = parseProductionHostKind(env.MISSION_HOST_KIND);
  const dshArgsPrefix = parseStringArrayEnv(env.MISSION_DSH_ARGS_PREFIX_JSON, "MISSION_DSH_ARGS_PREFIX_JSON");
  const codexArgsPrefix = parseStringArrayEnv(env.MISSION_CODEX_ARGS_PREFIX_JSON, "MISSION_CODEX_ARGS_PREFIX_JSON");
  const allowInsecureTrustedMcpHttp = env.MISSION_TRUSTED_MCP_ALLOW_HTTP === "1";
  const trustedMcpServers = parseTrustedMcpServersJson(env.MISSION_TRUSTED_MCP_SERVERS_JSON, {
    allowInsecureHttp: allowInsecureTrustedMcpHttp
  });
  const providerEvidenceRoutes = parseTrustedProviderEvidenceRoutesJson(
    env.MISSION_EVIDENCE_PROVIDER_ROUTES_JSON
  );
  const hostEvidenceCapabilities = parseTrustedHostCapabilityEvidenceBindingsJson(
    env.MISSION_HOST_EVIDENCE_BINDINGS_JSON
  );
  return createMissionRuntime({
    rootDir,
    dbPath: env.MISSION_DB ? resolve(env.MISSION_DB) : resolve(rootDir, "mission.db"),
    schemaPath: resolve(cwd, "src", "persistence", "sqlite", "schema.sql"),
    hostKind,
    dshBinary: env.MISSION_DSH_BINARY || "dsh",
    dshArgsPrefix,
    codexBinary: env.MISSION_CODEX_BINARY || "codex",
    codexArgsPrefix,
    codexModel: env.MISSION_CODEX_MODEL?.trim() || undefined,
    executorId: env.MISSION_EXECUTOR_ID || (hostKind === "codex" ? "codex-host" : "deepseek-host"),
    approvalTimeoutMs: positiveNumber(env.MISSION_APPROVAL_TIMEOUT_MS),
    controlTimeoutMs: positiveNumber(env.MISSION_CONTROL_TIMEOUT_MS),
    workTimeoutMs: positiveNumber(env.MISSION_WORK_TIMEOUT_MS),
    maxSupervisorCycles: positiveNumber(env.MISSION_MAX_CYCLES_PER_WAKE),
    retainControlWorkspaces: env.MISSION_RETAIN_CONTROL_WORKSPACES === "1",
    capabilityAcquisition: capabilityAcquisitionFromEnv(env),
    trustedMcpServers,
    allowInsecureTrustedMcpHttp,
    providerEvidenceRoutes,
    hostEvidenceCapabilities
  });
}

function createCapabilityRuntime(input: {
  root: string;
  host: HostAdapter;
  overlay: MissionCapabilityOverlay;
  approvals: RuntimeApprovalManager;
  acquisition?: ProductionCapabilityAcquisitionOptions;
  trustedCache?: TrustedCapabilityCache;
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
    maxCandidates: input.acquisition.maxCandidates,
    trustedCache: input.trustedCache
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

function parseProductionHostKind(value: string | undefined): ProductionHostKind {
  const normalized = value?.trim() || "deepseek";
  if (normalized === "deepseek" || normalized === "codex") return normalized;
  throw new Error(`Unsupported MISSION_HOST_KIND: ${normalized}`);
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
