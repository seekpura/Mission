import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor,
  HostMcpServer
} from "./host-adapter.ts";
import type { DeepSeekBindings } from "./deepseek-host-adapter.ts";

export interface DeepSeekAcpProcessOptions {
  binary?: string;
  argsPrefix?: string[];
  env?: NodeJS.ProcessEnv;
  cancelGraceMs?: number;
  approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
}

interface RunningAgent {
  request: AgentCreateRequest;
  handle: HostAgentHandle;
  child: ChildProcessWithoutNullStreams;
  connection: acp.ClientConnection;
  sessionId: string;
  session?: acp.ActiveSession;
  supportsClose: boolean;
  events: AsyncEventQueue<HostAgentEvent>;
  stderr: string;
  finished: boolean;
}

export class DeepSeekAcpProcessBindings implements DeepSeekBindings {
  private readonly binary: string;
  private readonly argsPrefix: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly cancelGraceMs: number;
  private readonly approvalHandler?: (request: ApprovalRequest) => Promise<ApprovalResult>;
  private readonly running = new Map<string, RunningAgent>();

  constructor(options: DeepSeekAcpProcessOptions = {}) {
    this.binary = options.binary ?? "dsh";
    this.argsPrefix = [...(options.argsPrefix ?? [])];
    this.env = { ...process.env, ...(options.env ?? {}) };
    this.cancelGraceMs = Math.max(0, options.cancelGraceMs ?? 1_500);
    this.approvalHandler = options.approvalHandler;
  }

  async describe(): Promise<HostDescriptor> {
    return {
      type: "deepseek-harness",
      metadata: {
        transport: "acp-v1",
        profile: "acp",
        binary: this.binary
      }
    };
  }

  async environment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describe(),
      capabilities: [
        {
          id: "deepseek-harness.acp-agent",
          kind: "agent",
          name: "DeepSeek Harness ACP Agent",
          description: "Create, resume and drive DeepSeek Harness sessions through the standard ACP v1 profile.",
          hostNative: true,
          available: true,
          invocationRef: "dsh --profile acp",
          permissions: ["host-agent-session", "host-agent-session-resume"],
          scope: "host"
        }
      ],
      shellAvailable: false,
      filesystemAvailable: false,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    await assertWorkspace(workspaceRoot);

    const processState = await this.spawnConnection(request);
    const { child, connection, events, stderrRef } = processState;
    let runningRef: RunningAgent | undefined;

    try {
      const initialized = await initialize(connection);
      const session = await connection.agent.buildSession({
        cwd: workspaceRoot,
        mcpServers: toAcpMcpServers(request.mcpServers ?? [])
      }).start();
      const sessionId = String(session.sessionId);
      const handle: HostAgentHandle = { id: randomUUID(), nativeRef: sessionId };
      const running: RunningAgent = {
        request,
        handle,
        child,
        connection,
        sessionId,
        session,
        supportsClose: supportsSessionCapability(initialized, "close"),
        events,
        stderr: stderrRef.value,
        finished: false
      };
      runningRef = running;
      this.running.set(handle.id, running);
      processState.bindStderr(running);

      events.push(event("started", {
        nativeSessionId: sessionId,
        workspaceRoot,
        transport: "acp-v1",
        resumed: false,
        mcpServerNames: (request.mcpServers ?? []).map(server => server.name)
      }));

      void this.runNewSessionPrompt(running, compilePrompt(request));
      return handle;
    } catch (error) {
      connection.close(error);
      if (child.exitCode === null) child.kill();
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create DeepSeek Harness ACP agent: ${detail}${stderrRef.value ? `\n${stderrRef.value}` : ""}`);
    } finally {
      if (!runningRef && child.exitCode === null) child.kill();
    }
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    await assertWorkspace(workspaceRoot);
    if (!request.nativeRef.trim()) return { status: "failed", reason: "DeepSeek ACP resume requires nativeRef" };
    if (!request.handleId.trim()) return { status: "failed", reason: "DeepSeek ACP resume requires handleId" };
    if (this.running.has(request.handleId)) {
      return {
        status: "resumed",
        handle: this.running.get(request.handleId)!.handle
      };
    }

    const processState = await this.spawnConnection(request, request.nativeRef);
    const { child, connection, events, stderrRef } = processState;
    let runningRef: RunningAgent | undefined;

    try {
      const initialized = await initialize(connection);
      if (!supportsSessionCapability(initialized, "resume")) {
        connection.close();
        if (child.exitCode === null) child.kill();
        return {
          status: "unsupported",
          reason: "DeepSeek ACP agent did not advertise agentCapabilities.sessionCapabilities.resume"
        };
      }

      try {
        await connection.agent.request(acp.methods.agent.session.resume, {
          sessionId: request.nativeRef,
          cwd: workspaceRoot,
          mcpServers: toAcpMcpServers(request.mcpServers ?? [])
        });
      } catch (error) {
        connection.close(error);
        if (child.exitCode === null) child.kill();
        const detail = error instanceof Error ? error.message : String(error);
        if (error instanceof acp.RequestError && error.code === -32002) {
          return { status: "not_found", reason: `DeepSeek ACP session not found: ${request.nativeRef}` };
        }
        return {
          status: "failed",
          reason: `DeepSeek ACP session/resume failed for ${request.nativeRef}: ${detail}${stderrRef.value ? `\n${stderrRef.value}` : ""}`
        };
      }

      const handle: HostAgentHandle = { id: request.handleId, nativeRef: request.nativeRef };
      const running: RunningAgent = {
        request,
        handle,
        child,
        connection,
        sessionId: request.nativeRef,
        supportsClose: supportsSessionCapability(initialized, "close"),
        events,
        stderr: stderrRef.value,
        finished: false
      };
      runningRef = running;
      this.running.set(handle.id, running);
      processState.bindStderr(running);

      events.push(event("started", {
        nativeSessionId: request.nativeRef,
        workspaceRoot,
        transport: "acp-v1",
        resumed: true,
        mcpServerNames: (request.mcpServers ?? []).map(server => server.name)
      }));

      void this.runResumedSessionPrompt(running, compileRecoveryPrompt(request));
      return { status: "resumed", handle };
    } catch (error) {
      connection.close(error);
      if (child.exitCode === null) child.kill();
      const detail = error instanceof Error ? error.message : String(error);
      return {
        status: "failed",
        reason: `Failed to reconnect DeepSeek Harness ACP session ${request.nativeRef}: ${detail}${stderrRef.value ? `\n${stderrRef.value}` : ""}`
      };
    } finally {
      if (!runningRef && child.exitCode === null) child.kill();
    }
  }

  async steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    const running = this.requireRunning(handle);
    if (running.finished) throw new Error(`DeepSeek agent is already finished: ${handle.id}`);
    throw new Error(
      `Mid-turn steering is not yet supported by the DeepSeek ACP binding. ` +
      `Cancel and create a revised work item instead. Requested delta: ${JSON.stringify(delta)}`
    );
  }

  async cancelAgent(handle: HostAgentHandle): Promise<void> {
    const running = this.requireRunning(handle);
    if (running.finished) return;

    await running.connection.agent.notify(acp.methods.agent.session.cancel, {
      sessionId: running.sessionId
    });

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

  async invokeCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return {
      ok: false,
      error: `DeepSeek ACP process binding does not expose arbitrary host capability invocation: ${request.capabilityId}`
    };
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.approvalHandler) return { approved: false };
    return this.approvalHandler(request);
  }

  private async spawnConnection(
    request: AgentCreateRequest,
    observedSessionId?: string
  ): Promise<{
    child: ChildProcessWithoutNullStreams;
    connection: acp.ClientConnection;
    events: AsyncEventQueue<HostAgentEvent>;
    stderrRef: { value: string };
    bindStderr(running: RunningAgent): void;
  }> {
    const workspaceRoot = request.workspaceRoot ?? process.cwd();
    const child = spawn(this.binary, [...this.argsPrefix, "--profile", "acp"], {
      cwd: workspaceRoot,
      env: this.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    await waitForSpawn(child);

    const events = new AsyncEventQueue<HostAgentEvent>();
    const stderrRef = { value: "" };
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderrRef.value = `${stderrRef.value}${String(chunk)}`.slice(-16_384);
    });

    let runningRef: RunningAgent | undefined;
    let client = acp
      .client({ name: "mission-runtime" })
      .onRequest(acp.methods.client.session.requestPermission, async ({ params }) => {
        return this.answerPermission(request, params);
      });

    if (observedSessionId) {
      client = client.onNotification(acp.methods.client.session.update, ({ params }) => {
        if (!runningRef || params.sessionId !== observedSessionId) return;
        const mapped = mapSessionUpdate(params);
        if (mapped) runningRef.events.push(mapped);
      });
    }

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin),
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    );
    const connection = client.connect(stream);

    return {
      child,
      connection,
      events,
      stderrRef,
      bindStderr(running: RunningAgent) {
        runningRef = running;
        child.stderr.on("data", () => { running.stderr = stderrRef.value; });
      }
    };
  }

  private async runNewSessionPrompt(running: RunningAgent, prompt: string): Promise<void> {
    try {
      const session = running.session;
      if (!session) throw new Error(`Missing active ACP session helper for ${running.sessionId}`);
      void session.prompt(prompt);
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          running.events.push(event("completed", {
            stopReason: message.stopReason,
            nativeSessionId: running.sessionId,
            resumed: false
          }));
          break;
        }
        const mapped = mapSessionUpdate(message.notification);
        if (mapped) running.events.push(mapped);
      }
    } catch (error) {
      this.emitRunFailure(running, error);
    } finally {
      await this.finishRunning(running);
    }
  }

  private async runResumedSessionPrompt(running: RunningAgent, prompt: string): Promise<void> {
    try {
      const response = await running.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: running.sessionId,
        prompt: [{ type: "text", text: prompt }]
      });
      running.events.push(event("completed", {
        stopReason: response.stopReason,
        nativeSessionId: running.sessionId,
        resumed: true
      }));
    } catch (error) {
      this.emitRunFailure(running, error);
    } finally {
      await this.finishRunning(running);
    }
  }

  private emitRunFailure(running: RunningAgent, error: unknown): void {
    running.events.push(event("failed", {
      error: error instanceof Error ? error.message : String(error),
      stderr: running.stderr || undefined,
      nativeSessionId: running.sessionId
    }));
  }

  private async finishRunning(running: RunningAgent): Promise<void> {
    running.finished = true;
    if (running.supportsClose) {
      try {
        await running.connection.agent.request(acp.methods.agent.session.close, {
          sessionId: running.sessionId
        });
      } catch {
        // Closing a supported protocol session is best-effort after the turn terminates.
      }
    }
    running.session?.dispose();
    running.connection.close();
    if (running.child.exitCode === null) running.child.kill();
    running.events.close();
  }

  private async answerPermission(
    request: AgentCreateRequest,
    params: acp.RequestPermissionRequest
  ): Promise<acp.RequestPermissionResponse> {
    const decision = this.approvalHandler
      ? await this.approvalHandler({
          missionId: request.missionId,
          title: params.toolCall.title || "DeepSeek Harness permission request",
          reason: `DeepSeek Harness requested permission for tool call ${params.toolCall.toolCallId}.`,
          details: {
            workItemId: request.workItemId,
            toolCall: params.toolCall,
            options: params.options
          }
        })
      : { approved: false };

    const desiredKind = decision.approved ? "allow_once" : "reject_once";
    const selected = params.options.find(option => option.kind === desiredKind);
    if (!selected) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }

  private requireRunning(handle: HostAgentHandle): RunningAgent {
    const running = this.running.get(handle.id);
    if (!running) throw new Error(`Unknown DeepSeek agent handle: ${handle.id}`);
    return running;
  }
}

async function initialize(connection: acp.ClientConnection): Promise<acp.InitializeResponse> {
  return connection.agent.request(acp.methods.agent.initialize, {
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {}
  });
}

function supportsSessionCapability(
  initialized: acp.InitializeResponse,
  capability: "resume" | "close"
): boolean {
  const sessionCapabilities = initialized.agentCapabilities?.sessionCapabilities;
  return Boolean(sessionCapabilities && capability in sessionCapabilities);
}

function toAcpMcpServers(servers: readonly HostMcpServer[]): acp.McpServer[] {
  return servers.map(server => server.transport === "stdio"
    ? {
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(entry => ({ name: entry.name, value: entry.value }))
      }
    : {
        type: "http" as const,
        name: server.name,
        url: server.url,
        headers: server.headers.map(entry => ({ name: entry.name, value: entry.value }))
      });
}

function compilePrompt(request: AgentCreateRequest): string {
  const context = typeof request.context === "string"
    ? request.context
    : JSON.stringify(request.context, null, 2);
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
  const context = typeof request.context === "string"
    ? request.context
    : JSON.stringify(request.context, null, 2);
  return [
    "Mission Runtime recovery continuation.",
    `Mission: ${request.missionId}`,
    `Work item: ${request.workItemId}`,
    `Recovered native session: ${request.nativeRef}`,
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

function mapSessionUpdate(notification: acp.SessionNotification): HostAgentEvent | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
    case "plan":
    case "user_message_chunk":
      return event("message", update);
    case "tool_call":
    case "tool_call_update":
      return event("tool", update);
    default:
      return event("message", update);
  }
}

function event(type: HostAgentEvent["type"], payload: unknown): HostAgentEvent {
  return { type, payload, at: new Date().toISOString() };
}

async function assertWorkspace(workspaceRoot: string): Promise<void> {
  if (!isAbsolute(workspaceRoot)) throw new Error(`DeepSeek ACP workspace must be absolute: ${workspaceRoot}`);
  const info = await stat(workspaceRoot);
  if (!info.isDirectory()) throw new Error(`DeepSeek ACP workspace is not a directory: ${workspaceRoot}`);
  await access(workspaceRoot, constants.R_OK | constants.X_OK);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
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
