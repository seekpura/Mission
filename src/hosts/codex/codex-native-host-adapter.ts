import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { buildHostCapabilityGraph } from "../../core/capabilities/capability-graph.ts";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "../host-adapter.ts";
import { CodexAppServerHostAdapter } from "./codex-app-server-host-adapter.ts";
import {
  buildCodexNativeCapabilityCatalog,
  isCodexNativeSelectionCapabilityRef,
  parseCodexModelListPage,
  resolveCodexNativeSelection,
  type CodexModelCatalogEntry,
  type CodexNativeCapabilityCatalog,
  type CodexNativeSelection
} from "./codex-native-capabilities.ts";

export interface CodexNativeCapabilityHostOptions {
  binary?: string;
  argsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  cancelGraceMs?: number;
  model?: string;
  reasoningEffort?: string;
  nativeDiscovery?: boolean;
  nativeDiscoveryTimeoutMs?: number;
  nativeDiscoveryCacheMs?: number;
  nativeDiscoveryMaxPages?: number;
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
}

interface CatalogCache {
  catalog: CodexNativeCapabilityCatalog | null;
  expiresAt: number;
}

interface RpcEnvelope {
  jsonrpc?: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_DISCOVERY_CACHE_MS = 60_000;
const DEFAULT_DISCOVERY_MAX_PAGES = 4;
const MAX_DISCOVERED_MODELS = 256;

/**
 * Provider-semantic layer for Codex app-server.
 *
 * The existing app-server adapter remains the execution protocol implementation.
 * This wrapper adds bounded stable `model/list` discovery, exposes the returned
 * model/reasoning/multi-agent semantics as CapabilityDescriptors, and routes an
 * explicitly allowed provider capability selection into the exact Codex worker
 * instance used for create/resume/observe. It never advertises experimental
 * background-terminal APIs because production initialization keeps experimentalApi=false.
 */
export class CodexNativeCapabilityHostAdapter implements HostAdapter {
  private readonly binary: string;
  private readonly argsPrefix: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cancelGraceMs: number;
  private readonly configuredModel?: string;
  private readonly configuredReasoningEffort?: string;
  private readonly nativeDiscovery: boolean;
  private readonly discoveryTimeoutMs: number;
  private readonly discoveryCacheMs: number;
  private readonly discoveryMaxPages: number;
  private readonly approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  private readonly base: CodexAppServerHostAdapter;
  private readonly adapters = new Map<string, CodexAppServerHostAdapter>();
  private readonly handleAdapters = new Map<string, CodexAppServerHostAdapter>();
  private cache?: CatalogCache;
  private discoveryPromise?: Promise<CodexNativeCapabilityCatalog | null>;

  constructor(options: CodexNativeCapabilityHostOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.argsPrefix = [...(options.argsPrefix ?? [])];
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.cancelGraceMs = Math.max(0, options.cancelGraceMs ?? 1_500);
    this.configuredModel = options.model?.trim() || undefined;
    this.configuredReasoningEffort = options.reasoningEffort?.trim() || undefined;
    this.nativeDiscovery = options.nativeDiscovery ?? true;
    this.discoveryTimeoutMs = positiveInteger(options.nativeDiscoveryTimeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS, "Codex native discovery timeout");
    this.discoveryCacheMs = positiveInteger(options.nativeDiscoveryCacheMs, DEFAULT_DISCOVERY_CACHE_MS, "Codex native discovery cache TTL");
    this.discoveryMaxPages = positiveInteger(options.nativeDiscoveryMaxPages, DEFAULT_DISCOVERY_MAX_PAGES, "Codex native discovery max pages");
    this.approvalHandler = options.approvalHandler;
    this.base = this.createExecutionAdapter({
      ...(this.configuredModel ? { model: this.configuredModel } : {}),
      ...(this.configuredReasoningEffort ? { reasoningEffort: this.configuredReasoningEffort } : {})
    });
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const base = await this.base.snapshotEnvironment();
    if (!this.nativeDiscovery) return base;
    const catalog = await this.discoverCatalog(false);
    if (!catalog) return base;
    const capabilities = [...base.capabilities, ...catalog.capabilities];
    return {
      ...base,
      capabilities,
      capabilityGraph: buildHostCapabilityGraph({
        revision: base.revision,
        host: base.host,
        capabilities,
        shellAvailable: base.shellAvailable,
        filesystemAvailable: base.filesystemAvailable,
        browserAvailable: base.browserAvailable
      }),
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const adapter = await this.adapterForRequest(request);
    const handle = await adapter.createAgent(request);
    this.bindHandle(handle, adapter);
    return handle;
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    const alreadyBound = this.handleAdapters.get(request.handleId);
    const adapter = alreadyBound ?? await this.adapterForRequest(request);
    const result = await adapter.resumeAgent(request);
    if (result.status === "resumed") this.bindHandle(result.handle, adapter);
    return result;
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.requireHandleAdapter(handle).steerAgent(handle, delta);
  }

  cancelAgent(handle: HostAgentHandle): Promise<void> {
    return this.requireHandleAdapter(handle).cancelAgent(handle);
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const adapter = this.requireHandleAdapter(handle);
    try {
      for await (const event of adapter.observeAgent(handle)) yield event;
    } finally {
      this.handleAdapters.delete(handle.id);
    }
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }

  private async adapterForRequest(request: AgentCreateRequest): Promise<CodexAppServerHostAdapter> {
    const hasNativeSelection = request.allowedCapabilityRefs.some(isCodexNativeSelectionCapabilityRef);
    let catalog: CodexNativeCapabilityCatalog;
    if (hasNativeSelection) {
      if (!this.nativeDiscovery) {
        throw new Error("Codex native capability selection was requested while native model discovery is disabled");
      }
      const discovered = await this.discoverCatalog(true);
      if (!discovered) throw new Error("Codex native model catalog is unavailable for the requested capability selection");
      catalog = discovered;
    } else {
      catalog = emptyCatalog();
    }
    const selection = resolveCodexNativeSelection({
      catalog,
      allowedCapabilityRefs: request.allowedCapabilityRefs,
      configuredModel: this.configuredModel,
      configuredReasoningEffort: this.configuredReasoningEffort
    });
    if (!hasNativeSelection && selection.model === this.configuredModel && selection.reasoningEffort === this.configuredReasoningEffort) {
      return this.base;
    }
    const key = `${selection.model ?? "provider-default"}\u0000${selection.reasoningEffort ?? "provider-default"}`;
    let adapter = this.adapters.get(key);
    if (!adapter) {
      adapter = this.createExecutionAdapter(selection);
      this.adapters.set(key, adapter);
    }
    return adapter;
  }

  private createExecutionAdapter(selection: CodexNativeSelection): CodexAppServerHostAdapter {
    return new CodexAppServerHostAdapter({
      binary: this.binary,
      argsPrefix: [
        ...this.argsPrefix,
        ...(selection.reasoningEffort
          ? ["-c", `model_reasoning_effort=${JSON.stringify(selection.reasoningEffort)}`]
          : [])
      ],
      env: this.env,
      cancelGraceMs: this.cancelGraceMs,
      ...(selection.model ? { model: selection.model } : {}),
      approvalHandler: this.approvalHandler
    });
  }

  private bindHandle(handle: HostAgentHandle, adapter: CodexAppServerHostAdapter): void {
    const existing = this.handleAdapters.get(handle.id);
    if (existing && existing !== adapter) throw new Error(`Codex handle ${handle.id} is already bound to a different native selection`);
    this.handleAdapters.set(handle.id, adapter);
  }

  private requireHandleAdapter(handle: HostAgentHandle): CodexAppServerHostAdapter {
    const adapter = this.handleAdapters.get(handle.id);
    if (!adapter) throw new Error(`Unknown Codex native host handle: ${handle.id}`);
    return adapter;
  }

  private async discoverCatalog(required: boolean): Promise<CodexNativeCapabilityCatalog | null> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) {
      if (required && !this.cache.catalog) throw new Error("Codex native model discovery is temporarily unavailable");
      return this.cache.catalog;
    }
    if (this.discoveryPromise) {
      const pending = await this.discoveryPromise;
      if (required && !pending) throw new Error("Codex native model discovery is unavailable");
      return pending;
    }

    this.discoveryPromise = this.queryCatalog()
      .then(catalog => {
        this.cache = { catalog, expiresAt: Date.now() + this.discoveryCacheMs };
        return catalog;
      })
      .catch(error => {
        const failureTtl = Math.min(this.discoveryCacheMs, 15_000);
        this.cache = { catalog: null, expiresAt: Date.now() + failureTtl };
        if (required) throw error;
        return null;
      })
      .finally(() => {
        this.discoveryPromise = undefined;
      });
    return this.discoveryPromise;
  }

  private async queryCatalog(): Promise<CodexNativeCapabilityCatalog> {
    const child = spawn(this.binary, [...this.argsPrefix, "app-server", "--stdio"], {
      cwd: process.cwd(),
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    await waitForSpawn(child);
    const stderr = { value: "" };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr.value = `${stderr.value}${String(chunk)}`.slice(-16_384);
    });
    const rpc = new CatalogJsonRpcConnection(child);
    try {
      return await withTimeout((async () => {
        await initializeCatalogRpc(rpc);
        const models: CodexModelCatalogEntry[] = [];
        let cursor: string | undefined;
        const seenCursors = new Set<string>();
        for (let pageIndex = 0; pageIndex < this.discoveryMaxPages; pageIndex += 1) {
          const page = parseCodexModelListPage(await rpc.request("model/list", compact({
            limit: 100,
            ...(cursor ? { cursor } : {})
          })));
          models.push(...page.models);
          if (models.length > MAX_DISCOVERED_MODELS) throw new Error(`Codex model catalog exceeds ${MAX_DISCOVERED_MODELS} models`);
          if (!page.nextCursor) return buildCodexNativeCapabilityCatalog(models);
          if (seenCursors.has(page.nextCursor)) throw new Error(`Codex model/list repeated cursor ${page.nextCursor}`);
          seenCursors.add(page.nextCursor);
          cursor = page.nextCursor;
        }
        throw new Error(`Codex model/list exceeded ${this.discoveryMaxPages} pages`);
      })(), this.discoveryTimeoutMs, "Codex native model discovery timed out");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Codex native model discovery failed: ${detail}${stderr.value ? `\n${stderr.value}` : ""}`);
    } finally {
      rpc.close();
      if (child.exitCode === null) child.kill();
    }
  }
}

class CatalogJsonRpcConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private nextId = 1;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: RpcEnvelope;
      try { message = JSON.parse(trimmed) as RpcEnvelope; } catch { return; }
      if (message.method && message.id !== undefined) {
        this.write({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Unsupported discovery server request: ${message.method}` } });
        return;
      }
      if (message.method || message.id === undefined) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "Codex discovery JSON-RPC failed"));
      else pending.resolve(message.result);
    });
    child.once("exit", (code, signal) => {
      this.close(new Error(`Codex discovery app-server exited (code=${String(code)}, signal=${String(signal)})`));
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`Codex discovery connection is closed before ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.write({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params });
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const reason = error instanceof Error ? error : new Error(error ? String(error) : "Codex discovery connection closed");
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private write(message: RpcEnvelope): void {
    if (this.closed) throw new Error("Codex discovery connection is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

async function initializeCatalogRpc(rpc: CatalogJsonRpcConnection): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: { name: "mission_runtime", title: "Mission Runtime", version: "0.1.0" },
    capabilities: { experimentalApi: false }
  });
  rpc.notify("initialized");
}

function emptyCatalog(): CodexNativeCapabilityCatalog {
  return { models: [], capabilities: [], selectionByCapabilityId: new Map() };
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
