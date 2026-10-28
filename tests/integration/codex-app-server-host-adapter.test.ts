import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerHostAdapter } from "../../src/hosts/codex/codex-app-server-host-adapter.ts";
import type { HostAgentEvent } from "../../src/hosts/host-adapter.ts";

const FAKE_CODEX = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turnCounter = 0;
let currentTurn = null;
let pendingApprovalTurn = null;
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
function terminal(status) {
  const turn = { id: currentTurn, status };
  send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-fixed", turn } });
}
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, { userAgent: "fake-codex" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" && message.id !== undefined) {
    reply(message.id, { thread: { id: "thread-fixed" }, model: "fake", modelProvider: "fake" });
    return;
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    if (message.params.threadId === "missing-thread") {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "no rollout found for thread id missing-thread" } });
    } else {
      reply(message.id, { thread: { id: message.params.threadId }, model: "fake", modelProvider: "fake" });
    }
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    currentTurn = "turn-" + (++turnCounter);
    const prompt = message.params.input?.[0]?.text || "";
    reply(message.id, { turn: { id: currentTurn, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: currentTurn, status: "inProgress" } } });
    if (prompt.includes("approval-case")) {
      send({ jsonrpc: "2.0", method: "item/started", params: { threadId: message.params.threadId, turnId: currentTurn, item: { id: "cmd-1", type: "commandExecution", command: "echo hello", cwd: process.cwd(), status: "inProgress" } } });
      pendingApprovalTurn = currentTurn;
      send({ jsonrpc: "2.0", id: 900 + turnCounter, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: currentTurn, itemId: "cmd-1", command: "echo hello", cwd: process.cwd(), reason: "run fixture command", availableDecisions: ["accept", "decline", "cancel"] } });
      return;
    }
    if (prompt.includes("hold-case")) return;
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: currentTurn, delta: "hello from codex" } });
    terminal("completed");
    return;
  }
  if (message.method === "turn/steer" && message.id !== undefined) {
    reply(message.id, { turnId: message.params.expectedTurnId });
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId: currentTurn, delta: "steered" } });
    return;
  }
  if (message.method === "turn/interrupt" && message.id !== undefined) {
    reply(message.id, {});
    terminal("interrupted");
    return;
  }
  if (message.id !== undefined && message.result && pendingApprovalTurn) {
    const decision = message.result.decision;
    if (decision === "accept" || decision === "acceptForSession") {
      send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-fixed", turnId: pendingApprovalTurn, item: { id: "cmd-1", type: "commandExecution", command: "echo hello", cwd: process.cwd(), status: "completed" } } });
      send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: "thread-fixed", turnId: pendingApprovalTurn, delta: "approved command complete" } });
      terminal("completed");
    } else {
      terminal("interrupted");
    }
    pendingApprovalTurn = null;
  }
});
`;

async function fixture() {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-host-"));
  const script = join(root, "fake-codex.cjs");
  await writeFile(script, FAKE_CODEX, "utf8");
  return { root, script };
}

async function collect(adapter: CodexAppServerHostAdapter, handle: { id: string; nativeRef?: string }): Promise<HostAgentEvent[]> {
  const events: HostAgentEvent[] = [];
  for await (const event of adapter.observeAgent(handle)) events.push(event);
  return events;
}

test("Codex app-server adapter creates and resumes a durable native thread", async () => {
  const { root, script } = await fixture();
  try {
    const adapter = new CodexAppServerHostAdapter({ binary: process.execPath, argsPrefix: [script] });
    const snapshot = await adapter.snapshotEnvironment();
    assert.equal(snapshot.host.type, "openai-codex");
    assert.equal(snapshot.capabilities[0]?.native?.protocol, "codex-app-server-jsonrpc-v2");

    const handle = await adapter.createAgent({
      missionId: "mission-codex-create",
      workItemId: "work-create",
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "ordinary-case"
    });
    assert.equal(handle.nativeRef, "thread-fixed");
    const first = await collect(adapter, handle);
    assert(first.some(event => event.type === "started" && (event.payload as { resumed?: boolean }).resumed === false));
    assert(first.some(event => event.type === "message" && (event.payload as { text?: string }).text === "hello from codex"));
    assert(first.some(event => event.type === "completed"));

    const resumed = await adapter.resumeAgent({
      missionId: "mission-codex-create",
      workItemId: "work-create",
      handleId: handle.id,
      nativeRef: handle.nativeRef!,
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "ordinary-case"
    });
    assert.equal(resumed.status, "resumed");
    if (resumed.status !== "resumed") return;
    const second = await collect(adapter, resumed.handle);
    assert(second.some(event => event.type === "started" && (event.payload as { resumed?: boolean }).resumed === true));
    assert(second.some(event => event.type === "completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex native command approval is bridged through Runtime approval and correlated with tool events", async () => {
  const { root, script } = await fixture();
  try {
    const approvals: Array<{ kind?: string; toolCallId?: string }> = [];
    const adapter = new CodexAppServerHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      approvalHandler: async request => {
        const toolCall = request.details?.toolCall as { kind?: string; toolCallId?: string } | undefined;
        approvals.push({ kind: toolCall?.kind, toolCallId: toolCall?.toolCallId });
        return { approved: true, scope: "once" };
      }
    });
    const handle = await adapter.createAgent({
      missionId: "mission-codex-approval",
      workItemId: "work-approval",
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "approval-case"
    });
    const events = await collect(adapter, handle);
    assert.deepEqual(approvals, [{ kind: "command", toolCallId: "cmd-1" }]);
    const toolEvents = events.filter(event => event.type === "tool").map(event => event.payload as { toolCallId?: string; status?: string });
    assert(toolEvents.some(event => event.toolCallId === "cmd-1" && event.status === "running"));
    assert(toolEvents.some(event => event.toolCallId === "cmd-1" && event.status === "completed"));
    assert(events.some(event => event.type === "completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex active turn supports host-native steer and bounded interrupt", async () => {
  const { root, script } = await fixture();
  try {
    const adapter = new CodexAppServerHostAdapter({ binary: process.execPath, argsPrefix: [script], cancelGraceMs: 100 });
    const handle = await adapter.createAgent({
      missionId: "mission-codex-steer",
      workItemId: "work-steer",
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "hold-case"
    });
    await adapter.steerAgent(handle, { message: "change course" });
    await adapter.cancelAgent(handle);
    const events = await collect(adapter, handle);
    assert(events.some(event => event.type === "message" && (event.payload as { text?: string }).text === "steered"));
    assert(events.some(event => event.type === "failed" && String((event.payload as { status?: string }).status) === "interrupted"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex resume reports not_found when native thread history is unavailable", async () => {
  const { root, script } = await fixture();
  try {
    const adapter = new CodexAppServerHostAdapter({ binary: process.execPath, argsPrefix: [script] });
    const result = await adapter.resumeAgent({
      missionId: "mission-codex-missing",
      workItemId: "work-missing",
      handleId: "handle-missing",
      nativeRef: "missing-thread",
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "recovery"
    });
    assert.equal(result.status, "not_found");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex adapter refuses Mission MCP declarations until a provider-native projection exists", async () => {
  const { root, script } = await fixture();
  try {
    const adapter = new CodexAppServerHostAdapter({ binary: process.execPath, argsPrefix: [script] });
    await assert.rejects(
      () => adapter.createAgent({
        missionId: "mission-codex-mcp",
        workItemId: "work-mcp",
        workspaceRoot: root,
        allowedCapabilityRefs: ["trusted-mcp:one"],
        context: "mcp",
        mcpServers: [{ transport: "stdio", name: "one", command: "/bin/echo", args: [], env: [] }]
      }),
      /does not yet accept Mission trusted MCP projection/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
