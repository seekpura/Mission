import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkExecutionRouter } from "../../src/runtime/orchestration/executor-router.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../../src/execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { HostAgentExecutionRequest } from "../../src/execution/host/host-agent-execution-backend.ts";

function work(id: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId: "m", purpose: "production", objective: id, status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "shared", type: "document", required: false }], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}

test("cancelling a local execution releases resource and artifact leases for the next execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-cancel-router-"));
  const tool = join(root, "delay.mjs");
  writeFileSync(tool, `import fs from 'node:fs'; const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8')); setTimeout(()=>console.log(JSON.stringify({status:'completed',summary:'done',outputs:[],proposedFacts:[],proposedWork:[],warnings:[]})), input.delay);`, "utf8");
  const capability: CapabilityDescriptor = { id: "cli", kind: "cli", name: "delay", description: "delay", hostNative: false, available: true, invocationRef: tool, permissions: [], scope: "mission", metadata: { directProtocol: "worker-envelope-stdio", argsTemplate: ["{input}"], exclusiveResources: ["shared-resource"] } };
  const host = new FakeHostAdapter();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new FileArtifactStore(root);
  const router = new WorkExecutionRouter({ host, agents: new HostAgentExecutionBackend(host), hostCapabilities: new HostCapabilityExecutionBackend(host), local: new LocalExecutionBackend(workspaces, artifacts) });
  const request = (id: string, delay: number): HostAgentExecutionRequest => {
    const workspaceRoot = join(root, `workspace-${id}`);
    mkdirSync(workspaceRoot, { recursive: true });
    return { executionId: id, missionId: "m", workItemId: id, attemptId: `a-${id}`, executor: { id: "agent", type: "host_agent" }, contextPacketId: `c-${id}`, inputArtifactRefs: [], expectedOutputs: [], capabilityRefs: [capability.id], workspacePolicy: { mode: "isolated", lifecycle: "attempt" }, isolationPolicy: { level: "restricted", filesystemIsolation: true, networkIsolation: true, processIsolation: true, secretIsolation: true }, permissionEnvelope: { readPaths: [], writePaths: [], network: "deny", allowedEnvKeys: [], subprocess: true, packageInstall: false, secretAccess: "deny", hostMutation: false }, timeoutPolicy: { hardTimeoutMs: 10000 }, retryPolicy: { runtimeRetries: 0 }, sideEffectPolicy: { externalWrites: "deny", destructiveWrites: "deny", irreversibleActions: "deny", idempotencyRequired: true }, context: { delay }, workspaceRoot };
  };
  const first = router.execute({ work: work("w1"), capabilities: [capability], baseRequest: request("e1", 5000) });
  await new Promise(resolve => setTimeout(resolve, 120));
  const second = router.execute({ work: work("w2"), capabilities: [capability], baseRequest: request("e2", 30) });
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(await router.cancel("e1"), true);
  assert.equal((await first).result.state, "cancelled");
  assert.equal((await second).result.state, "succeeded");
});
