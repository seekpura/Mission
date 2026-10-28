import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";

test("LocalExecutionBackend refuses to collect a declared artifact outside its attempt workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-local-containment-"));
  try {
    const backend = new LocalExecutionBackend(
      new WorkspaceManager(join(root, "workspaces")),
      new FileArtifactStore(join(root, "artifact-store"))
    );
    const handle = await backend.allocate({
      executionId: "escape-execution",
      missionId: "mission-local-containment",
      workItemId: "work-escape",
      attemptId: "attempt-escape",
      executor: { id: "node", type: "cli" },
      contextPacketId: "context-escape",
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "escape", type: "file", required: true }],
      capabilityRefs: [],
      workspacePolicy: { type: "filesystem", lifecycle: "ephemeral" },
      isolationPolicy: {
        level: "host",
        networkIsolation: false,
        filesystemIsolation: false,
        processIsolation: false,
        secretIsolation: false
      },
      permissionEnvelope: {
        filesystemRead: ["*"],
        filesystemWrite: ["*"],
        network: "allow",
        networkHosts: [],
        allowedEnvKeys: [],
        subprocess: true,
        packageInstall: true,
        secrets: "scoped",
        hostMutation: true
      },
      timeoutPolicy: { hardTimeoutMs: 5_000 },
      retryPolicy: { runtimeRetries: 0 },
      sideEffectPolicy: {
        externalWrites: "allow",
        destructiveWrites: "approval",
        irreversibleActions: "approval",
        idempotencyRequired: false
      },
      localCommand: {
        command: process.execPath,
        args: ["-e", "require('fs').writeFileSync('../escape.txt','outside workspace')"]
      },
      outputFiles: [{ path: "../escape.txt", logicalName: "escape", type: "file" }]
    });

    await backend.start(handle);
    await assert.rejects(backend.collectOutcome(handle), /escapes workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
