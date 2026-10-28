import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServerHostAdapter } from "../../src/hosts/codex/codex-app-server-host-adapter.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { HostAgentWorkExecutionDriver } from "../../src/execution/host/host-agent-work-execution-driver.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

const FAKE_CODEX_ARTIFACT = String.raw`
const fs = require("node:fs");
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, { userAgent: "fake-codex-driver" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" && message.id !== undefined) {
    reply(message.id, { thread: { id: "thread-driver" }, model: "fake", modelProvider: "fake" });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    const turnId = "turn-driver";
    reply(message.id, { turn: { id: turnId, status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: turnId, status: "inProgress" } } });
    fs.writeFileSync("deliverable.txt", "artifact produced through codex host", "utf8");
    fs.writeFileSync(".mission-output.json", JSON.stringify({ outputs: [{ path: "deliverable.txt", logicalName: "deliverable", type: "file", mimeType: "text/plain" }] }), "utf8");
    send({ jsonrpc: "2.0", method: "item/agentMessage/delta", params: { threadId: message.params.threadId, turnId, delta: "artifact ready" } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
  }
});
`;

function executionInput() {
  return {
    state: {
      missionId: "mission-codex-driver",
      status: "active" as const,
      revision: 1,
      missionSpecRevision: 1,
      acceptanceRevision: 1,
      strategyRevision: 1,
      graphRevision: 1,
      environmentSnapshotRevision: 0,
      activeWorkstreamIds: [],
      activeWorkItemIds: [],
      readyWorkItemIds: ["work-codex"],
      blockedWorkItemIds: [],
      verifyingWorkItemIds: [],
      openGapIds: [],
      blockingGapIds: [],
      activeExecutionIds: [],
      pendingApprovalIds: [],
      finalArtifactRefs: [],
      lastEventSequence: 1
    },
    workItem: {
      id: "work-codex",
      missionId: "mission-codex-driver",
      purpose: "production" as const,
      objective: "produce a portable host artifact",
      status: "ready" as const,
      requirementRefs: ["req-codex"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: [],
      priority: 1,
      graphRevision: 1,
      createdBy: "planner" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    },
    contextPacket: {
      id: "context-codex",
      missionId: "mission-codex-driver",
      workItemId: "work-codex",
      objective: "produce a portable host artifact",
      requirementRefs: ["req-codex"],
      constraintRefs: [],
      truthRefs: [],
      sourceRefs: [],
      artifactRefs: [],
      decisionRefs: [],
      localAcceptanceCriteria: [],
      allowedCapabilityRefs: ["openai-codex.app-server-agent"],
      recentFailureRefs: [],
      contextVersion: 1,
      compilerManifest: {
        missionRevision: 1,
        graphRevision: 1,
        generatedAt: new Date().toISOString()
      }
    },
    attemptId: "attempt-codex",
    executionId: "execution-codex"
  };
}

test("generic HostAgentWorkExecutionDriver commits an Artifact produced through Codex app-server", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-driver-"));
  const script = join(root, "fake-codex-driver.cjs");
  await writeFile(script, FAKE_CODEX_ARTIFACT, "utf8");
  try {
    const host = new CodexAppServerHostAdapter({ binary: process.execPath, argsPrefix: [script] });
    const driver = new HostAgentWorkExecutionDriver(
      host,
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    let binding: { nativeRef?: string; hostHandleId?: string } | undefined;
    const input = {
      ...executionInput(),
      lifecycle: {
        async bindRuntime(value: { nativeRef?: string; hostHandleId?: string }) { binding = value; }
      }
    };

    const outcome = await driver.execute(input);

    assert.equal(binding?.nativeRef, "thread-driver");
    assert.equal(typeof binding?.hostHandleId, "string");
    assert.equal(outcome.result.state, "succeeded");
    assert.deepEqual(outcome.result.committedArtifactRefs, ["deliverable@1"]);
    assert.equal(outcome.artifacts.length, 1);
    assert.equal(outcome.artifacts[0]?.logicalName, "deliverable");
    assert.equal(outcome.artifacts[0]?.status, "candidate");
    assert.equal(outcome.artifacts[0]?.mimeType, "text/plain");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
