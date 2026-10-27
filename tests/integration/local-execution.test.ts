import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";

test("local execution produces and commits a candidate artifact", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-exec-"));
  const workspaces = new WorkspaceManager(root);
  const artifacts = new FileArtifactStore(root);
  const backend = new LocalExecutionBackend(workspaces, artifacts);
  const handle = await backend.allocate({
    executionId: "e1", missionId: "m1", workItemId: "w1", attemptId: "a1",
    executor: { id: "node", type: "cli" }, contextPacketId: "c1", inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "result", type: "document", required: true }], capabilityRefs: [],
    workspacePolicy: { type: "filesystem", lifecycle: "ephemeral" },
    isolationPolicy: { level: "restricted", networkIsolation: true, filesystemIsolation: true, processIsolation: false, secretIsolation: true },
    permissionEnvelope: { filesystemRead: [], filesystemWrite: ["."], network: "deny", networkHosts: [], allowedEnvKeys: [], subprocess: true, packageInstall: false, secrets: "deny", hostMutation: false },
    timeoutPolicy: { hardTimeoutMs: 5000 }, retryPolicy: { runtimeRetries: 0 },
    sideEffectPolicy: { externalWrites: "deny", destructiveWrites: "deny", irreversibleActions: "deny", idempotencyRequired: true },
    localCommand: { command: process.execPath, args: ["-e", "require('fs').writeFileSync('result.txt','mission output')"] },
    outputFiles: [{ path: "result.txt", logicalName: "result", type: "document" }]
  });
  await backend.start(handle);
  const result = await backend.collect(handle);
  assert.equal(result.state, "succeeded");
  assert.deepEqual(result.committedArtifactRefs, ["result@1"]);
  assert.ok(existsSync(result.producedFiles[0]!.path));
  rmSync(root, { recursive: true, force: true });
});
