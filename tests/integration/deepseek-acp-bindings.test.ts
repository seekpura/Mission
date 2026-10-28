import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DeepSeekHarnessAdapter } from "../../src/hosts/deepseek/deepseek-host-adapter.ts";
import { DeepSeekAcpProcessBindings } from "../../src/hosts/deepseek/acp-process-bindings.ts";

const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/fake-acp-agent.mjs"
);

test("DeepSeek ACP binding runs initialize/session/prompt/update/permission/stop", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "mission-dsh-acp-"));
  const approvals: Array<{ title: string; reason: string }> = [];

  try {
    const bindings = new DeepSeekAcpProcessBindings({
      binary: process.execPath,
      argsPrefix: [fixture],
      approvalHandler: async request => {
        approvals.push({ title: request.title, reason: request.reason });
        return { approved: true, scope: "once" };
      }
    });
    const adapter = new DeepSeekHarnessAdapter(bindings);

    const descriptor = await adapter.describeHost();
    assert.equal(descriptor.type, "deepseek-harness");
    assert.equal(descriptor.metadata?.transport, "acp-v1");

    const snapshot = await adapter.snapshotEnvironment();
    assert.equal(snapshot.capabilities.some(cap => cap.id === "deepseek-harness.acp-agent"), true);

    const handle = await adapter.createAgent({
      missionId: "mission-acp-test",
      workItemId: "work-1",
      context: { objective: "Exercise the real ACP transport path" },
      allowedCapabilityRefs: ["deepseek-harness.acp-agent"],
      workspaceRoot: workspace
    });

    assert.match(handle.nativeRef ?? "", /^fake-session-/);

    const events = [];
    for await (const event of adapter.observeAgent(handle)) events.push(event);

    assert.equal(events[0]?.type, "started");
    assert.equal(events.some(event => event.type === "message"), true);
    assert.equal(events.some(event => event.type === "tool"), true);
    assert.equal(events.at(-1)?.type, "completed");
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]?.title, "Edit fake artifact");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("DeepSeek ACP binding rejects relative workspaces before launching a process", async () => {
  const bindings = new DeepSeekAcpProcessBindings({
    binary: process.execPath,
    argsPrefix: [fixture]
  });
  const adapter = new DeepSeekHarnessAdapter(bindings);

  await assert.rejects(
    adapter.createAgent({
      missionId: "mission-acp-test",
      workItemId: "work-relative",
      context: {},
      allowedCapabilityRefs: [],
      workspaceRoot: "relative/workspace"
    }),
    /workspace must be absolute/
  );
});
