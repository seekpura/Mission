import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexNativeCapabilityHostAdapter,
  compileCodexMcpProjection
} from "../../src/hosts/codex/codex-native-host-adapter.ts";
import type { HostAgentEvent, HostMcpServer } from "../../src/hosts/host-adapter.ts";
import { TrustedMcpHostAdapter, TrustedMcpRegistry } from "../../src/runtime/trusted-mcp-runtime.ts";

const FIXTURE = String.raw`
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const logPath = process.env.FAKE_CODEX_MCP_LOG;
function log(value) { if (logPath) appendFileSync(logPath, JSON.stringify(value) + "\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
log({ type: "argv", argv: process.argv.slice(2) });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) return reply(message.id, {});
  if (message.method === "initialized") return;
  if (message.method === "thread/start" && message.id !== undefined) {
    return reply(message.id, { thread: { id: "mcp-thread" } });
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    return reply(message.id, { thread: { id: message.params.threadId } });
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    const id = "turn-" + (++turn);
    reply(message.id, { turn: { id, status: "inProgress" } });
    return send({ jsonrpc: "2.0", method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: { id, status: "completed" }
    } });
  }
});
`;

async function collect(host: TrustedMcpHostAdapter, handle: { id: string; nativeRef?: string }): Promise<HostAgentEvent[]> {
  const events: HostAgentEvent[] = [];
  for await (const event of host.observeAgent(handle)) events.push(event);
  return events;
}

async function rows(path: string): Promise<any[]> {
  return (await readFile(path, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
}

test("trusted no-secret MCP is delivered through Codex provider-native process config", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-mcp-"));
  const script = join(root, "fake-codex-mcp.cjs");
  const log = join(root, "codex-mcp.jsonl");
  await writeFile(script, FIXTURE, "utf8");
  await writeFile(log, "", "utf8");
  const registry = new TrustedMcpRegistry([
    {
      id: "trusted-mcp:local-docs",
      name: "local_docs",
      description: "read-only local documentation server",
      revision: "docs-r1",
      transport: "stdio",
      command: "/opt/mission/mcp-docs",
      args: ["--read-only"]
    },
    {
      id: "trusted-mcp:remote-docs",
      name: "remote_docs",
      description: "read-only remote documentation server",
      revision: "remote-r1",
      transport: "http",
      url: "https://mcp.example.test/mcp"
    }
  ]);
  const host = new TrustedMcpHostAdapter(new CodexNativeCapabilityHostAdapter({
    binary: process.execPath,
    argsPrefix: [script],
    env: { ...process.env, FAKE_CODEX_MCP_LOG: log },
    nativeDiscovery: false
  }), registry);

  try {
    const snapshot = await host.snapshotEnvironment();
    const codex = snapshot.capabilities.find(capability => capability.id === "openai-codex.app-server-agent");
    assert(codex?.native?.features?.includes("provider-native-mcp-config"));

    const handle = await host.createAgent({
      missionId: "mission-codex-mcp",
      workItemId: "work-codex-mcp",
      workspaceRoot: root,
      allowedCapabilityRefs: ["trusted-mcp:local-docs", "trusted-mcp:remote-docs"],
      context: "use documentation MCP when useful"
    });
    const events = await collect(host, handle);
    assert(events.some(event => event.type === "completed"));

    const argv = (await rows(log)).find(row => row.type === "argv")?.argv as string[];
    assert(argv.includes('mcp_servers.local_docs.command="/opt/mission/mcp-docs"'));
    assert(argv.includes('mcp_servers.local_docs.args=["--read-only"]'));
    assert(argv.includes('mcp_servers.remote_docs.url="https://mcp.example.test/mcp"'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("secret-bearing trusted MCP remains fail-closed on Codex", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-mcp-secret-"));
  const script = join(root, "fake-codex-mcp.cjs");
  await writeFile(script, FIXTURE, "utf8");
  const registry = new TrustedMcpRegistry([{
    id: "trusted-mcp:secret-docs",
    name: "secret_docs",
    description: "authenticated docs",
    revision: "secret-r1",
    transport: "http",
    url: "https://mcp.example.test/mcp",
    headers: [{ name: "Authorization", value: "Bearer top-secret" }]
  }]);
  const host = new TrustedMcpHostAdapter(new CodexNativeCapabilityHostAdapter({
    binary: process.execPath,
    argsPrefix: [script],
    nativeDiscovery: false
  }), registry);
  try {
    await assert.rejects(
      () => host.createAgent({
        missionId: "mission-codex-mcp-secret",
        workItemId: "work-codex-mcp-secret",
        workspaceRoot: root,
        allowedCapabilityRefs: ["trusted-mcp:secret-docs"],
        context: "must not leak secrets"
      }),
      /secure provider-native secret projection is not implemented/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex MCP projection rejects config injection and ambiguous server identity", () => {
  const stdio: HostMcpServer = {
    transport: "stdio",
    name: "local_docs",
    command: "/opt/mission/mcp-docs",
    args: ["--read-only"],
    env: []
  };
  const http: HostMcpServer = {
    transport: "http",
    name: "remote_docs",
    url: "https://mcp.example.test/mcp",
    headers: []
  };

  assert.throws(
    () => compileCodexMcpProjection([{ ...stdio, name: "bad.name" }]),
    /server name is unsafe/
  );
  assert.throws(
    () => compileCodexMcpProjection([{ ...stdio, command: "relative-command" }]),
    /command must be an absolute path/
  );
  assert.throws(
    () => compileCodexMcpProjection([stdio, { ...http, name: stdio.name }]),
    /Duplicate Codex MCP server name/
  );
  assert.throws(
    () => compileCodexMcpProjection([{ ...http, url: "https://user:password@example.test/mcp" }]),
    /credential-bearing URL/
  );
});
