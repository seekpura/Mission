import test from "node:test";
import assert from "node:assert/strict";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";

function request() {
  return {
    executionId: "host-exec-1", missionId: "m1", workItemId: "w1", attemptId: "a1",
    executor: { id: "host", type: "host_agent" as const }, contextPacketId: "ctx1", context: { objective: "produce result" },
    inputArtifactRefs: [], expectedOutputs: [], capabilityRefs: [], workspacePolicy: { type: "filesystem" as const, lifecycle: "ephemeral" as const },
    isolationPolicy: { level: "host" as const, networkIsolation: false, filesystemIsolation: false, processIsolation: false, secretIsolation: true },
    permissionEnvelope: { filesystemRead: [], filesystemWrite: [], network: "deny" as const, networkHosts: [], allowedEnvKeys: [], subprocess: false, packageInstall: false, secrets: "deny" as const, hostMutation: false },
    timeoutPolicy: {}, retryPolicy: { runtimeRetries: 0 }, sideEffectPolicy: { externalWrites: "deny" as const, destructiveWrites: "deny" as const, irreversibleActions: "deny" as const, idempotencyRequired: true }
  };
}

test("host-agent execution backend turns host agent completion into an execution result", async () => {
  const host = new FakeHostAdapter();
  const backend = new HostAgentExecutionBackend(host);
  const handle = await backend.allocate(request());
  await backend.start(handle);
  const result = await backend.collect(handle);
  assert.equal(result.state, "succeeded");
  assert.equal(result.runtimeObservationRef, "{}");
});
