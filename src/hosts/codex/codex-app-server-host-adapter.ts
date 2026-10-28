import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

export interface CodexAppServerHostOptions {
  binary?: string;
  argsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  cancelGraceMs?: number;
  model?: string;
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
}

interface CachedToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  rawInput?: unknown;
}

interface RunningAgent {
  request: AgentCreateRequest;
  handle: HostAgentHandle;
  child: ChildProcessWithoutNullStreams;
  rpc: CodexJsonRpcConnection;
  threadId: string;
  turnId?: string;
  events: AsyncEventQueue<HostAgentEvent>;
  stderr: string;
  finished: boolean;
  toolCalls: Map<string, CachedToolCall>;
}

interface SpawnedConnection {
  child: ChildProcessWithoutNullStreams;
  rpc: CodexJsonRpcConnection;
  events: AsyncEventQueue<HostAgentEvent>;
  stderrRef: { value: string };
  bindRunning(running: RunningAgent): void;
}

interface JsonRpcEnvelope {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface JsonRpcHandlers {
  onNotification(method: string, params: unknown): void;
  onServerRequest(method: string, params: unknown): Promise<unknown>;
}

type CodexSandboxMode = "read-only" | "workspace-write";

export class CodexAppServerHostAdapter implements HostAdapter {
  private readonly binary: string;
  private readonly argsPrefix: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cancelGraceMs: number;
  private readonly model?: string;
  private readonly approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  private readonly running = new Map<string, RunningAgent>();

  constructor(options: CodexAppServerHostOptions = {}) {
    this.binary = options.binary ?? "codex";
    this.argsPrefix = [...(options.argsPrefix ?? [])];
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.cancelGraceMs = Math.max(0, options.cancelGraceMs ?? 1_500);
    this.model = options.model?.trim() || undefined;
    this.approvalHandler = options.approvalHandler;
  }

  async describeHost(): Promise<HostDescriptor> {
    return {
      type: "openai-codex",
      metadata: {
        transport: "app-server-jsonrpc-v2",
        binary: this.binary,
        command: "app-server --stdio"
      }
    };
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const host = await this.describeHost();
    const capabilities = [
      {
        id: "openai-codex.app-server-agent",
        kind: "agent" as const,
        name: "OpenAI Codex app-server Agent",
        description: "Create, resume, steer, interrupt and observe Codex threads through the native app-server JSON-RPC protocol.",
        hostNative: true,
        available: true,
        invocationRef: "codex app-server --stdio",
        permissions: ["host-agent-session", "host-agent-session-resume", "host-agent-approval"],
        scope: "host" as const,
        functions: [
          "create agent session",
          "resume agent session",
          "execute mission work",
          "observe agent execution",
          "steer active agent turn",
          "cancel active agent turn",
          "produce workspace artifacts"
        ],
        accepts: ["mission context", "work item", "workspace", "capability instructions"],
        produces: ["artifact", "execution evidence", "agent events"],
        constraints: {
          supportedPurposes: ["production", "verification", "research", "integration"]
        },
        routing: {
          executionMode: "host-agent" as const,
          resumable: true,
          concurrent: true,
          isolation: "host" as const
        },
        cost: {
          monetaryClass: "unknown" as const,
          latencyClass: "interactive" as const,
          metered: true
        },
        native: {
          provider: "openai-codex",
          nativeId: "app-server-agent",
          protocol: "codex-app-server-jsonrpc-v2",
          loadMode: "preinstalled" as const,
          approvalModes: ["once", "provider-native"],
          features: [
            "thread-start",
            "thread-resume",
            "turn-start",
            "turn-steer",
            "turn-interrupt",
            "observe-events",
            "workspace-context",
            "workspace-write",
            "control-read-only",
            "command-approval",
            "file-change-approval"
          ],
          persistence: ["thread", "resume", "recovery"]
        },
        provenance: {
          source: "host" as const,
          sourceRef: "codex app-server --stdio"
        }
      }
    ];
    const capabilityGraph = buildHostCapabilityGraph({
      revision: 1,
      host,
      capabilities,
      shellAvailable: true,
      filesystemAvailable: true,
      browserAvailable: false
    });
    return {
      revision: 1,
      host,
      capabilities,
      capabilityGraph,
      shellAvailable: true,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.assertNoDirectMcp(request);
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    await assertWorkspace(workspaceRoot, "Codex app-server");
    const processState = await this.spawnConnection(request);
    const { child, rpc, events, stderrRef } = processState;
    let runningRef: RunningAgent | undefined;

    try {
      await initializeCodex(rpc);
      const start = asRecord(await rpc.request("thread/start", compact({
        cwd: workspaceRoot,
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandbox: sandboxModeFor(request),
        ephemeral: false,
        model: this.model
      })));
      const thread = asRecord(start.thread);
      const threadId = requiredString(thread.id, "Codex thread/start response.thread.id");
      const handle: HostAgentHandle = { id: randomUUID(), nativeRef: threadId };
      const running: RunningAgent = {
        request,
        handle,
        child,
        rpc,
        threadId,
        events,
        stderr: stderrRef.value,
        finished: false,
        toolCalls: new Map()
      };
      runningRef = running;
      this.running.set(handle.id, running);
      processState.bindRunning(running);
      await this.startTurn(running, compilePrompt(request), false);
      return handle;
    } catch (error) {
      this.disposeUnbound(processState, runningRef, error);
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create Codex app-server agent: ${detail}${stderrRef.value ? `\n${stderrRef.value}` : ""}`);
    }
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    this.assertNoDirectMcp(request);
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    await assertWorkspace(workspaceRoot, "Codex app-server");
    if (!request.nativeRef.trim()) return { status: "failed", reason: "Codex resume requires nativeRef" };
    if (!request.handleId.trim()) return { status: "failed", reason: "Codex resume requires handleId" };
    const active = this.running.get(request.handleId);
    if (active) return { status: "resumed", handle: active.handle };

    const processState = await this.spawnConnection(request);
    const { child, rpc, events, stderrRef } = processState;
    let runningRef: RunningAgent | undefined;
    try {
      await initializeCodex(rpc);
      try {
        await rpc.request("thread/resume", compact({
          threadId: request.nativeRef,
          cwd: workspaceRoot,
          approvalPolicy: "untrusted",
          approvalsReviewer: "user",
          sandbox: sandboxModeFor(request),
          excludeTurns: true,
          model: this.model
        }));
      } catch (error) {
        rpc.close(error);
        if (child.exitCode === null) child.kill();
        if (isCodexThreadNotFound(error)) {
          return { status: "not_found", reason: `Codex thread not found: ${request.nativeRef}` };
        }
        return {
          status: "failed",
          reason: `Codex thread/resume failed for ${request.nativeRef}: ${errorMessage(error)}${stderrRef.value ? `\n${stderrRef.value}` : ""}`
        };
      }

      const handle: HostAgentHandle = { id: request.handleId, nativeRef: request.nativeRef };
      const running: RunningAgent = {
        request,
        handle,
        child,
        rpc,
        threadId: request.nativeRef,
        events,
        stderr: stderrRef.value,
        finished: false,
        toolCalls: new Map()
      };
      runningRef = running;
      this.running.set(handle.id, running);
      processState.bindRunning(running);
      await this.startTurn(running, compileRecoveryPrompt(request), true);
      return { status: "resumed", handle };
    } catch (error) {
      this.disposeUnbound(processState, runningRef, error);
      return {
        status: "failed",
        reason: `Failed to reconnect Codex thread ${request.nativeRef}: ${errorMessage(error)}${stderrRef.value ? `\n${stderrRef.value}` : ""}`
      };
    }
  }

  async steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    const running = this.requireRunning(handle);
    if (running.finished) throw new Error(`Codex agent is already finished: ${handle.id}`);
    if (!running.turnId) throw new Error(`Codex agent has no active turn to steer: ${handle.id}`);
    const text = delta.message?.trim() || JSON.stringify(delta);
    await running.rpc.request("turn/steer", {
      threadId: running.threadId,
      expectedTurnId: running.turnId,
      input: [{ type: "text", text }]
    });
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    const running = this.requireRunning(handle);
    if (running.finished) return;
    if (running.turnId) {
      try {
        await running.rpc.request("turn/interrupt", {
          threadId: running.threadId,
          turnId: running.turnId
        });
      } catch {
        // Process termination below remains the bounded fallback.
      }
    }
    if (running.finished) return;
    const fallback = setTimeout(() => {
      if (!running.finished && running.child.exitCode === null) running.child.kill();
    }, this.cancelGraceMs);
    fallback.unref();
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const running = this.requireRunning(handle);
    try {
      for (;;) {
        const next = await running.events.next();
        if (next === null) return;
        yield next;
      }
    } finally {
      if (running.finished) this.running.delete(handle.id);
    }
  }

  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return {
      ok: false,
      error: `Codex app-server HostAdapter does not expose arbitrary host capability invocation: ${request.capabilityId}`
    };
  }

  async requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.approvalHandler) return { approved: false };
    return this.approvalHandler(request);
  }

  private async spawnConnection(request: AgentCreateRequest): Promise<SpawnedConnection> {
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    const child = spawn(this.binary, [...this.argsPrefix, "app-server", "--stdio"], {
      cwd: workspaceRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    await waitForSpawn(child);
    const events = new AsyncEventQueue<HostAgentEvent>();
    const stderrRef = { value: "" };
    let runningRef: RunningAgent | undefined;

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderrRef.value = `${stderrRef.value}${String(chunk)}`.slice(-16_384);
      if (runningRef) runningRef.stderr = stderrRef.value;
    });

    const rpc = new CodexJsonRpcConnection(child, {
      onNotification: (method, params) => {
        if (runningRef) this.handleNotification(runningRef, method, params);
      },
      onServerRequest: async (method, params) => {
        if (!runningRef) return failClosedApprovalResponse(method);
        return this.answerServerRequest(runningRef, method, params);
      }
    });

    child.once("exit", (code, signal) => {
      if (!runningRef || runningRef.finished) return;
      runningRef.events.push(event("failed", {
        error: `Codex app-server exited before a terminal turn event (code=${String(code)}, signal=${String(signal)})`,
        stderr: runningRef.stderr || undefined,
        nativeSessionId: runningRef.threadId
      }));
      runningRef.finished = true;
      runningRef.rpc.close(new Error("Codex app-server process exited"));
      runningRef.events.close();
    });

    return {
      child,
      rpc,
      events,
      stderrRef,
      bindRunning(running: RunningAgent) {
        runningRef = running;
      }
    };
  }

  private async startTurn(running: RunningAgent, prompt: string, resumed: boolean): Promise<void> {
    const response = asRecord(await running.rpc.request("turn/start", {
      threadId: running.threadId,
      input: [{ type: "text", text: prompt }],
      cwd: running.request.workspaceRoot ?? process.cwd()
    }));
    const turn = asRecord(response.turn);
    running.turnId = requiredString(turn.id, "Codex turn/start response.turn.id");
    running.events.push(event("started", {
      nativeSessionId: running.threadId,
      nativeTurnId: running.turnId,
      workspaceRoot: running.request.workspaceRoot ?? process.cwd(),
      transport: "codex-app-server-jsonrpc-v2",
      resumed
    }));
  }

  private handleNotification(running: RunningAgent, method: string, params: unknown): void {
    if (running.finished) return;
    const record = asRecord(params);
    if (method === "turn/started") {
      const turn = asRecord(record.turn);
      const id = optionalString(turn.id);
      if (id) running.turnId = id;
      return;
    }
    if (method === "item/agentMessage/delta") {
      const text = optionalString(record.delta) ?? optionalString(record.text);
      if (text) running.events.push(event("message", { text, method }));
      return;
    }
    if (method === "item/started" || method === "item/completed") {
      const mapped = mapCodexToolEvent(method, record);
      if (mapped) {
        running.toolCalls.set(mapped.toolCall.toolCallId, mapped.toolCall);
        running.events.push(event("tool", mapped.payload));
      }
      return;
    }
    if (method === "item/commandExecution/outputDelta") {
      running.events.push(event("tool", {
        toolCallId: optionalString(record.itemId) ?? optionalString(record.callId) ?? "codex-command",
        kind: "command",
        status: "running",
        outputDelta: record.delta
      }));
      return;
    }
    if (method === "turn/completed") {
      const turn = asRecord(record.turn);
      const status = optionalString(turn.status) ?? "failed";
      if (status === "completed") {
        running.events.push(event("completed", {
          nativeSessionId: running.threadId,
          nativeTurnId: optionalString(turn.id) ?? running.turnId,
          status
        }));
      } else {
        running.events.push(event("failed", {
          error: `Codex turn ended with status ${status}`,
          nativeSessionId: running.threadId,
          nativeTurnId: optionalString(turn.id) ?? running.turnId,
          status,
          detail: turn.error
        }));
      }
      void this.finishRunning(running);
    }
  }

  private async answerServerRequest(running: RunningAgent, method: string, params: unknown): Promise<unknown> {
    if (!isApprovalMethod(method)) throw new JsonRpcRequestError(-32601, `Unsupported Codex server request: ${method}`);
    const record = asRecord(params);
    const toolCallId = optionalString(record.itemId) ?? optionalString(record.approvalId) ?? `${method}:${randomUUID()}`;
    const cached = running.toolCalls.get(toolCallId);
    const kind = method.includes("fileChange") ? "patch" : method.includes("commandExecution") ? "command" : "unknown";
    const toolCall: CachedToolCall = cached ?? {
      toolCallId,
      title: optionalString(record.reason) ?? (kind === "patch" ? "Codex file change" : kind === "command" ? "Codex command execution" : "Codex permission request"),
      kind,
      rawInput: compact({
        command: record.command,
        cwd: record.cwd,
        grantRoot: record.grantRoot,
        environmentId: record.environmentId,
        networkApprovalContext: record.networkApprovalContext,
        additionalPermissions: record.additionalPermissions
      })
    };
    running.toolCalls.set(toolCallId, toolCall);
    const decision = this.approvalHandler
      ? await this.approvalHandler({
          missionId: running.request.missionId,
          title: toolCall.title,
          reason: optionalString(record.reason) ?? `Codex requested approval for ${kind} ${toolCallId}.`,
          details: {
            workItemId: running.request.workItemId,
            toolCall,
            providerMethod: method
          }
        })
      : { approved: false };
    return { decision: chooseCodexApprovalDecision(decision.approved, record) };
  }

  private async finishRunning(running: RunningAgent): Promise<void> {
    if (running.finished) return;
    running.finished = true;
    running.rpc.close();
    if (running.child.exitCode === null) running.child.kill();
    running.events.close();
  }

  private requireRunning(handle: HostAgentHandle): RunningAgent {
    const running = this.running.get(handle.id);
    if (!running) throw new Error(`Unknown Codex agent handle: ${handle.id}`);
    return running;
  }

  private disposeUnbound(processState: SpawnedConnection, running: RunningAgent | undefined, error: unknown): void {
    if (running) {
      running.finished = true;
      this.running.delete(running.handle.id);
    }
    processState.rpc.close(error);
    if (processState.child.exitCode === null) processState.child.kill();
    processState.events.close();
  }

  private assertNoDirectMcp(request: AgentCreateRequest): void {
    if ((request.mcpServers?.length ?? 0) > 0) {
      throw new Error(
        "Codex app-server HostAdapter does not yet accept Mission trusted MCP projection; refusing to silently reinterpret provider configuration"
      );
    }
  }
}

class CodexJsonRpcConnection {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly handlers: JsonRpcHandlers;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  private nextId = 1;
  private closed = false;

  constructor(child: ChildProcessWithoutNullStreams, handlers: JsonRpcHandlers) {
    this.child = child;
    this.handlers = handlers;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on("line", line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: JsonRpcEnvelope;
      try {
        message = JSON.parse(trimmed) as JsonRpcEnvelope;
      } catch {
        return;
      }
      void this.handle(message);
    });
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error(`Codex JSON-RPC connection is closed before ${method}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closed) throw new Error(`Codex JSON-RPC connection is closed before notification ${method}`);
    this.write(params === undefined
      ? { jsonrpc: "2.0", method }
      : { jsonrpc: "2.0", method, params });
  }

  close(error?: unknown): void {
    if (this.closed) return;
    this.closed = true;
    const reason = error instanceof Error ? error : new Error(error ? String(error) : "Codex JSON-RPC connection closed");
    for (const pending of this.pending.values()) pending.reject(reason);
    this.pending.clear();
  }

  private async handle(message: JsonRpcEnvelope): Promise<void> {
    if (message.method && message.id !== undefined) {
      try {
        const result = await this.handlers.onServerRequest(message.method, message.params);
        this.write({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        const rpcError = error instanceof JsonRpcRequestError
          ? { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
          : { code: -32603, message: errorMessage(error) };
        this.write({ jsonrpc: "2.0", id: message.id, error: rpcError });
      }
      return;
    }
    if (message.method) {
      this.handlers.onNotification(message.method, message.params);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new JsonRpcRequestError(
          message.error.code ?? -32603,
          message.error.message ?? "Codex JSON-RPC request failed",
          message.error.data
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private write(message: JsonRpcEnvelope): void {
    if (this.closed) throw new Error("Codex JSON-RPC connection is closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

class JsonRpcRequestError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "JsonRpcRequestError";
    this.code = code;
    this.data = data;
  }
}

async function initializeCodex(rpc: CodexJsonRpcConnection): Promise<void> {
  await rpc.request("initialize", {
    clientInfo: {
      name: "mission_runtime",
      title: "Mission Runtime",
      version: "0.1.0"
    },
    capabilities: { experimentalApi: false }
  });
  rpc.notify("initialized");
}

function mapCodexToolEvent(method: string, params: Record<string, unknown>): { toolCall: CachedToolCall; payload: Record<string, unknown> } | null {
  const item = asRecord(params.item);
  const itemId = optionalString(item.id);
  const itemType = optionalString(item.type);
  if (!itemId || !itemType) return null;
  const kind = itemType === "commandExecution"
    ? "command"
    : itemType === "fileChange"
      ? "patch"
      : itemType === "mcpToolCall"
        ? "tool"
        : "";
  if (!kind) return null;
  const terminal = method === "item/completed";
  const itemStatus = optionalString(item.status);
  const status = terminal
    ? (itemStatus === "completed" ? "completed" : "failed")
    : "running";
  const title = optionalString(item.name)
    ?? optionalString(item.command)
    ?? (kind === "patch" ? "Codex file change" : kind === "command" ? "Codex command execution" : "Codex tool call");
  const rawInput = compact({
    command: item.command,
    cwd: item.cwd,
    changes: item.changes,
    tool: item.tool,
    arguments: item.arguments
  });
  const toolCall: CachedToolCall = { toolCallId: itemId, title, kind, rawInput };
  return {
    toolCall,
    payload: {
      toolCallId: itemId,
      title,
      kind,
      rawInput,
      status,
      providerItemType: itemType
    }
  };
}

function isApprovalMethod(method: string): boolean {
  return method === "item/commandExecution/requestApproval"
    || method === "item/fileChange/requestApproval"
    || method === "item/permissions/requestApproval";
}

function failClosedApprovalResponse(method: string): unknown {
  if (isApprovalMethod(method)) return { decision: "cancel" };
  throw new JsonRpcRequestError(-32601, `Unsupported Codex server request before agent binding: ${method}`);
}

function chooseCodexApprovalDecision(approved: boolean, params: Record<string, unknown>): string {
  if (approved) return "accept";
  const available = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
  if (available.some(value => value === "decline")) return "decline";
  return "cancel";
}

function sandboxModeFor(request: AgentCreateRequest): CodexSandboxMode {
  return request.workItemId.startsWith("control:") ? "read-only" : "workspace-write";
}

function compilePrompt(request: AgentCreateRequest): string {
  const context = typeof request.context === "string" ? request.context : JSON.stringify(request.context, null, 2);
  return [
    "Mission Runtime work assignment.",
    `Mission: ${request.missionId}`,
    `Work item: ${request.workItemId}`,
    request.allowedCapabilityRefs.length > 0
      ? `Allowed capability references: ${request.allowedCapabilityRefs.join(", ")}`
      : "Allowed capability references: none declared.",
    "The host runtime remains authoritative for tool, sandbox, and permission enforcement.",
    "",
    context
  ].join("\n");
}

function compileRecoveryPrompt(request: AgentResumeRequest): string {
  const context = typeof request.context === "string" ? request.context : JSON.stringify(request.context, null, 2);
  return [
    "Mission Runtime recovery continuation.",
    `Mission: ${request.missionId}`,
    `Work item: ${request.workItemId}`,
    `Recovered native thread: ${request.nativeRef}`,
    request.allowedCapabilityRefs.length > 0
      ? `Allowed capability references: ${request.allowedCapabilityRefs.join(", ")}`
      : "Allowed capability references: none declared.",
    "The previous client connection was interrupted.",
    "Inspect the existing workspace before acting and continue the same work item.",
    "Preserve valid partial outputs and the existing Mission output manifest when present.",
    "Do not repeat an external or irreversible side effect merely because the client reconnected; verify its current state first.",
    "The host runtime remains authoritative for tool, sandbox, and permission enforcement.",
    "",
    context
  ].join("\n");
}

function event(type: HostAgentEvent["type"], payload: unknown): HostAgentEvent {
  return { type, payload, at: new Date().toISOString() };
}

async function assertWorkspace(workspaceRoot: string, label: string): Promise<void> {
  if (!isAbsolute(workspaceRoot)) throw new Error(`${label} workspace must be absolute: ${workspaceRoot}`);
  const info = await stat(workspaceRoot);
  if (!info.isDirectory()) throw new Error(`${label} workspace is not a directory: ${workspaceRoot}`);
  await access(workspaceRoot, constants.R_OK | constants.X_OK);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
}

function isCodexThreadNotFound(error: unknown): boolean {
  if (!(error instanceof JsonRpcRequestError)) return false;
  if (error.code !== -32600 && error.code !== -32602) return false;
  const text = `${error.message} ${stringify(error.data)}`.toLowerCase();
  return text.includes("not found") || text.includes("no rollout") || text.includes("unknown thread");
}

function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`${label} is missing or empty`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function stringify(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(value: T | null) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<T | null> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(null);
    return new Promise(resolve => this.waiters.push(resolve));
  }
}
