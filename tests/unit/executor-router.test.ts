import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
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

function work(): WorkItem {
  const now = new Date().toISOString();
  return { id: "w", missionId: "m", purpose: "production", objective: "render report", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}
function capability(overrides: Partial<CapabilityDescriptor>): CapabilityDescriptor {
  return { id: "c", kind: "tool", name: "render", description: "render report", hostNative: true, available: true, permissions: [], scope: "host", ...overrides };
}
function router() {
  const root = mkdtempSync(join(tmpdir(), "mission-router-"));
  const host = new FakeHostAdapter();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new FileArtifactStore(root);
  return new WorkExecutionRouter({ host, agents: new HostAgentExecutionBackend(host), hostCapabilities: new HostCapabilityExecutionBackend(host), local: new LocalExecutionBackend(workspaces, artifacts) });
}

test("routes a single host tool directly", () => {
  assert.equal(router().select(work(), [capability({ kind: "tool" })]).kind, "host_capability");
});

test("keeps skills and multi-capability composition on a host agent", () => {
  assert.equal(router().select(work(), [capability({ kind: "skill" })]).kind, "host_agent");
  assert.equal(router().select(work(), [capability({ id: "a" }), capability({ id: "b", kind: "mcp" })]).kind, "host_agent");
});

test("routes an explicitly structured mission-local CLI directly", () => {
  const route = router().select(work(), [capability({ kind: "cli", hostNative: false, invocationRef: "/tmp/tool.js", scope: "mission", metadata: { directProtocol: "worker-envelope-stdio", argsTemplate: ["{input}"] } })]);
  assert.equal(route.kind, "local_cli");
});
