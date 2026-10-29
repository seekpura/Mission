import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { requiredCapabilityRefs } from "../../src/core/capabilities/capability-graph.ts";
import { CodexNativeCapabilityHostAdapter } from "../../src/hosts/codex/codex-native-host-adapter.ts";
import {
  CODEX_AGENT_CAPABILITY_ID,
  codexModelCapabilityId,
  codexMultiAgentCapabilityId,
  codexReasoningCapabilityId
} from "../../src/hosts/codex/codex-native-capabilities.ts";
import type { HostAgentEvent } from "../../src/hosts/host-adapter.ts";

const FAKE_CODEX_NATIVE = String.raw`
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const logPath = process.env.FAKE_CODEX_NATIVE_LOG;
function log(value) { if (logPath) appendFileSync(logPath, JSON.stringify(value) + "\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
log({ type: "argv", argv: process.argv.slice(2) });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let turn = 0;
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  log({ type: "rpc", method: message.method, params: message.params });
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, { userAgent: "fake-codex-native" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "model/list" && message.id !== undefined) {
    reply(message.id, {
      data: [
        {
          id: "gpt-6-codex",
          model: "gpt-6-codex",
          displayName: "GPT-6 Codex",
          description: "deep coding model",
          hidden: false,
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "balanced" },
            { reasoningEffort: "high", description: "deep" }
          ],
          defaultReasoningEffort: "medium",
          isDefault: true,
          multiAgentVersion: "v2"
        },
        {
          id: "gpt-5-fast",
          model: "gpt-5-fast",
          displayName: "GPT-5 Fast",
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low", description: "fast" }],
          defaultReasoningEffort: "low",
          isDefault: false,
          multiAgentVersion: "disabled"
        }
      ],
      nextCursor: null
    });
    return;
  }
  if (message.method === "thread/start" && message.id !== undefined) {
    reply(message.id, { thread: { id: "native-thread" }, model: message.params.model || "provider-default" });
    return;
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    reply(message.id, { thread: { id: message.params.threadId }, model: message.params.model || "provider-default" });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    const id = "turn-" + (++turn);
    reply(message.id, { turn: { id, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id, status: "completed" } } });
    return;
  }
});
`;

async function fixture() {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-native-"));
  const script = join(root, "fake-codex-native.cjs");
  const log = join(root, "codex-native.jsonl");
  await writeFile(script, FAKE_CODEX_NATIVE, "utf8");
  await writeFile(log, "", "utf8");
  return { root, script, log };
}

async function collect(adapter: CodexNativeCapabilityHostAdapter, handle: { id: string; nativeRef?: string }): Promise<HostAgentEvent[]> {
  const events: HostAgentEvent[] = [];
  for await (const event of adapter.observeAgent(handle)) events.push(event);
  return events;
}

async function logRows(path: string): Promise<Array<{ type: string; argv?: string[]; method?: string; params?: Record<string, unknown> }>> {
  return (await readFile(path, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("Codex stable model/list becomes graph capabilities and selected reasoning capability drives the worker model/config", async () => {
  const { root, script, log } = await fixture();
  try {
    const adapter = new CodexNativeCapabilityHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      env: { ...process.env, FAKE_CODEX_NATIVE_LOG: log },
      nativeDiscovery: true,
      nativeDiscoveryTimeoutMs: 2_000,
      nativeDiscoveryCacheMs: 60_000
    });

    const [snapshot, secondSnapshot] = await Promise.all([adapter.snapshotEnvironment(), adapter.snapshotEnvironment()]);
    assert.equal(snapshot.capabilities.length, secondSnapshot.capabilities.length);
    const modelId = codexModelCapabilityId("gpt-6-codex");
    const highId = codexReasoningCapabilityId("gpt-6-codex", "high");
    const multiId = codexMultiAgentCapabilityId("gpt-6-codex", "v2");
    assert(snapshot.capabilities.some(capability => capability.id === modelId));
    assert(snapshot.capabilities.some(capability => capability.id === highId));
    assert(snapshot.capabilities.some(capability => capability.id === multiId));
    assert(snapshot.capabilityGraph);
    assert.deepEqual(requiredCapabilityRefs(snapshot.capabilityGraph!, modelId), [CODEX_AGENT_CAPABILITY_ID]);
    assert.deepEqual(requiredCapabilityRefs(snapshot.capabilityGraph!, highId), [modelId]);
    assert.deepEqual(requiredCapabilityRefs(snapshot.capabilityGraph!, multiId), [modelId]);
    assert.equal(
      snapshot.capabilities.some(capability => capability.functions?.some(fn => fn.includes("background job"))),
      false,
      "experimental background-terminal APIs must not be advertised while experimentalApi=false"
    );

    const handle = await adapter.createAgent({
      missionId: "mission-native-model",
      workItemId: "work-native-model",
      workspaceRoot: root,
      allowedCapabilityRefs: [highId],
      context: "exercise selected provider model and reasoning"
    });
    const events = await collect(adapter, handle);
    assert(events.some(event => event.type === "completed"));

    const rows = await logRows(log);
    assert.equal(rows.filter(row => row.method === "model/list").length, 1, "concurrent snapshots should share one cached discovery");
    const threadStart = rows.find(row => row.method === "thread/start");
    assert.equal(threadStart?.params?.model, "gpt-6-codex");
    const workerArgv = rows
      .filter(row => row.type === "argv")
      .map(row => row.argv ?? [])
      .find(argv => argv.some(arg => arg === 'model_reasoning_effort="high"'));
    assert(workerArgv, "selected reasoning capability must reach provider-native app-server configuration");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex multi-agent capability pins its owning model without inventing a separate background-job capability", async () => {
  const { root, script, log } = await fixture();
  try {
    const adapter = new CodexNativeCapabilityHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      env: { ...process.env, FAKE_CODEX_NATIVE_LOG: log },
      nativeDiscovery: true,
      nativeDiscoveryTimeoutMs: 2_000
    });
    await adapter.snapshotEnvironment();
    const handle = await adapter.createAgent({
      missionId: "mission-native-multi",
      workItemId: "work-native-multi",
      workspaceRoot: root,
      allowedCapabilityRefs: [codexMultiAgentCapabilityId("gpt-6-codex", "v2")],
      context: "delegate when useful"
    });
    await collect(adapter, handle);
    const rows = await logRows(log);
    const threadStarts = rows.filter(row => row.method === "thread/start");
    assert.equal(threadStarts.at(-1)?.params?.model, "gpt-6-codex");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex native discovery failure degrades to the base agent capability but selected stale refs fail closed", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-native-failure-"));
  const script = join(root, "bad-codex-native.cjs");
  await writeFile(script, String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(v) { process.stdout.write(JSON.stringify(v) + "\n"); }
lines.on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") send({ jsonrpc: "2.0", id: m.id, result: {} });
  if (m.method === "model/list") send({ jsonrpc: "2.0", id: m.id, result: { data: "malformed" } });
});
`, "utf8");
  try {
    const adapter = new CodexNativeCapabilityHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      nativeDiscovery: true,
      nativeDiscoveryTimeoutMs: 1_000
    });
    const snapshot = await adapter.snapshotEnvironment();
    assert.deepEqual(snapshot.capabilities.map(capability => capability.id), [CODEX_AGENT_CAPABILITY_ID]);
    await assert.rejects(
      () => adapter.createAgent({
        missionId: "mission-native-stale",
        workItemId: "work-native-stale",
        workspaceRoot: root,
        allowedCapabilityRefs: [codexReasoningCapabilityId("gpt-6-codex", "high")],
        context: "stale selection"
      }),
      /native model discovery|temporarily unavailable|unavailable/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
