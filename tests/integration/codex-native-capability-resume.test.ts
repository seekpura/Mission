import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexNativeCapabilityHostAdapter } from "../../src/hosts/codex/codex-native-host-adapter.ts";
import { codexReasoningCapabilityId } from "../../src/hosts/codex/codex-native-capabilities.ts";

const FIXTURE = String.raw`
const { appendFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const logPath = process.env.FAKE_CODEX_RESUME_LOG;
function log(value) { appendFileSync(logPath, JSON.stringify(value) + "\n"); }
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
log({ type: "argv", argv: process.argv.slice(2) });
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", line => {
  const message = JSON.parse(line);
  log({ type: "rpc", method: message.method, params: message.params });
  if (message.method === "initialize" && message.id !== undefined) return reply(message.id, {});
  if (message.method === "initialized") return;
  if (message.method === "model/list" && message.id !== undefined) {
    return reply(message.id, { data: [{
      model: "gpt-6-codex",
      displayName: "GPT-6 Codex",
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "medium", description: "balanced" },
        { reasoningEffort: "high", description: "deep" }
      ],
      defaultReasoningEffort: "medium",
      isDefault: true,
      multiAgentVersion: "v2"
    }] });
  }
  if (message.method === "thread/resume" && message.id !== undefined) {
    return reply(message.id, { thread: { id: message.params.threadId }, model: message.params.model });
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    reply(message.id, { turn: { id: "resume-turn", status: "inProgress" } });
    return send({ jsonrpc: "2.0", method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: { id: "resume-turn", status: "completed" }
    } });
  }
});
`;

test("Codex recovery re-applies the durable provider-native model/reasoning selection", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-native-resume-"));
  const script = join(root, "fake-codex-resume.cjs");
  const log = join(root, "resume.jsonl");
  await writeFile(script, FIXTURE, "utf8");
  await writeFile(log, "", "utf8");
  try {
    const adapter = new CodexNativeCapabilityHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      env: { ...process.env, FAKE_CODEX_RESUME_LOG: log },
      nativeDiscovery: true,
      nativeDiscoveryTimeoutMs: 2_000
    });
    await adapter.snapshotEnvironment();
    const high = codexReasoningCapabilityId("gpt-6-codex", "high");
    const resumed = await adapter.resumeAgent({
      missionId: "mission-resume-native",
      workItemId: "work-resume-native",
      handleId: "durable-handle",
      nativeRef: "durable-thread",
      workspaceRoot: root,
      allowedCapabilityRefs: [high],
      context: "continue durable work"
    });
    assert.equal(resumed.status, "resumed");
    if (resumed.status !== "resumed") return;
    const events = [];
    for await (const event of adapter.observeAgent(resumed.handle)) events.push(event);
    assert(events.some(event => event.type === "completed"));

    const rows = (await readFile(log, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line));
    const resume = rows.find(row => row.method === "thread/resume");
    assert.equal(resume?.params?.model, "gpt-6-codex");
    assert(rows.some(row => row.type === "argv" && row.argv?.includes('model_reasoning_effort="high"')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
