import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "../../src/hosts/host-adapter.ts";
import { DrainableHostAdapter } from "../../src/runtime/drainable-host-adapter.ts";

class ReusedHandleHost implements HostAdapter {
  readonly handle = { id: "reused-active-handle", nativeRef: "native-session" };
  cancelCalls = 0;

  async describeHost(): Promise<HostDescriptor> { return { type: "reused-handle-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { return this.handle; }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> { this.cancelCalls += 1; }
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "completed", payload: {}, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

const request: AgentCreateRequest = {
  missionId: "mission-handle-identity",
  workItemId: "work-handle-identity",
  context: {},
  allowedCapabilityRefs: []
};

test("DrainableHostAdapter rejects concurrent reuse of an active provider handle id", async () => {
  const base = new ReusedHandleHost();
  const host = new DrainableHostAdapter(base);
  const first = await host.createAgent(request);

  await assert.rejects(() => host.createAgent(request), /reused active handle id/);
  assert.deepEqual(host.snapshot().activeHandleIds, [first.id]);
  assert.equal(host.snapshot().admissionsInFlight, 0);

  const events: HostAgentEvent[] = [];
  for await (const event of host.observeAgent(first)) events.push(event);
  assert.equal(events.at(-1)?.type, "completed");
  assert.deepEqual(host.snapshot().activeHandleIds, []);
});
