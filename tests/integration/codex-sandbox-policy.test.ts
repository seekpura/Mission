import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerHostAdapter } from "../../src/hosts/codex/codex-app-server-host-adapter.ts";

const FAKE_SANDBOX = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, {});
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" && message.id !== undefined) {
    if (message.params.sandbox !== process.env.EXPECTED_SANDBOX) {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32602, message: "sandbox mismatch: " + message.params.sandbox } });
      return;
    }
    reply(message.id, { thread: { id: "thread-sandbox" } });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    reply(message.id, { turn: { id: "turn-sandbox", status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn-sandbox", status: "completed" } } });
  }
});
`;

async function run(workItemId: string, expectedSandbox: string): Promise<void> {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-sandbox-"));
  const script = join(root, "fake-codex-sandbox.cjs");
  await writeFile(script, FAKE_SANDBOX, "utf8");
  try {
    const adapter = new CodexAppServerHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      env: { EXPECTED_SANDBOX: expectedSandbox }
    });
    const handle = await adapter.createAgent({
      missionId: "mission-sandbox",
      workItemId,
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "sandbox fixture"
    });
    const events = [];
    for await (const event of adapter.observeAgent(handle)) events.push(event);
    assert(events.some(event => event.type === "completed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Codex control sessions remain read-only", async () => {
  await run("control:planner", "read-only");
});

test("Codex Work sessions receive workspace-write so Mission artifacts can be produced", async () => {
  await run("work-production", "workspace-write");
});
