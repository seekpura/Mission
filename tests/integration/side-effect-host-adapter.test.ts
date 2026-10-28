import test from "node:test";
import assert from "node:assert/strict";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import type {
  AgentCreateRequest,
  ApprovalRequest,
  ApprovalResult,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle
} from "../../src/hosts/deepseek/host-adapter.ts";
import {
  RuntimeSideEffectManager,
  type SideEffectApprovalBroker,
  type SideEffectApprovalRequest
} from "../../src/runtime/side-effect-manager.ts";
import { SideEffectHostAdapter } from "../../src/runtime/side-effect-host-adapter.ts";

class MemoryEventStore implements EventStore {
  readonly events: MissionEvent[] = [];

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const scoped = this.events.filter(item => item.missionId === event.missionId);
    const duplicate = event.idempotencyKey
      ? scoped.find(item => item.idempotencyKey === event.idempotencyKey)
      : undefined;
    if (duplicate) return duplicate as MissionEvent<T>;
    if (scoped.length !== expectedSequence) throw new Error(`Concurrency conflict: expected sequence ${expectedSequence}, actual ${scoped.length}`);
    const stored = { ...event, sequence: scoped.length + 1 } as MissionEvent<T>;
    this.events.push(stored as MissionEvent);
    return stored;
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    return this.events.filter(event => event.missionId === missionId && event.sequence > afterSequence);
  }

  async lastSequence(missionId: string): Promise<number> {
    return this.events.filter(event => event.missionId === missionId).length;
  }
}

class ApprovalBroker implements SideEffectApprovalBroker {
  async requestHostApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: true, scope: "once" };
  }
  async requestSideEffectApproval(_request: SideEffectApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    return { approved: true, actor: "user" };
  }
}

class ScriptedHost implements HostAdapter {
  private readonly events: HostAgentEvent[];
  constructor(events: HostAgentEvent[]) { this.events = events; }
  async describeHost() { return { type: "scripted-side-effect-host" }; }
  async snapshotEnvironment() {
    return {
      revision: 1,
      host: { type: "scripted-side-effect-host" },
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> { return { id: "handle-1" }; }
  async resumeAgent() { return { status: "unsupported" as const, reason: "not used" }; }
  async steerAgent() {}
  async cancelAgent() {}
  async *observeAgent(): AsyncIterable<HostAgentEvent> { for (const event of this.events) yield event; }
  async invokeHostCapability() { return { ok: false, error: "not used" }; }
  async requestUserApproval() { return { approved: false }; }
}

function request(overrides: Partial<AgentCreateRequest> = {}): AgentCreateRequest {
  return {
    missionId: "mission-side-effect-host",
    workItemId: "work-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    context: {},
    allowedCapabilityRefs: [],
    workspaceRoot: "/tmp/mission-side-effect-host",
    ...overrides
  };
}

function sendEvents(): HostAgentEvent[] {
  const at = new Date().toISOString();
  return [
    { type: "started", payload: {}, at },
    {
      type: "tool",
      payload: {
        sessionUpdate: "tool_call",
        toolCallId: "send-1",
        title: "Send message",
        kind: "send",
        rawInput: { recipient: "a@example.test", body: "hello" }
      },
      at
    },
    {
      type: "tool",
      payload: {
        sessionUpdate: "tool_call_update",
        toolCallId: "send-1",
        status: "completed",
        rawOutput: { id: "message-1" }
      },
      at
    },
    { type: "completed", payload: { stopReason: "end_turn" }, at }
  ];
}

test("unadmitted observed host side effect converts apparent completion into failure", async () => {
  const store = new MemoryEventStore();
  const manager = new RuntimeSideEffectManager(store, new ApprovalBroker());
  const host = new SideEffectHostAdapter(new ScriptedHost(sendEvents()), manager);
  const handle = await host.createAgent(request());
  const observed: HostAgentEvent[] = [];
  for await (const event of host.observeAgent(handle)) observed.push(event);

  assert.equal(observed.at(-1)?.type, "failed");
  assert.match(JSON.stringify(observed.at(-1)?.payload), /Unadmitted side effect detected/);
  assert.equal(store.events.some(event => event.type === "side_effect.completed"), false);
});

test("admitted host side effect is durably settled before completed terminal event is released", async () => {
  const store = new MemoryEventStore();
  const manager = new RuntimeSideEffectManager(store, new ApprovalBroker());
  const host = new SideEffectHostAdapter(new ScriptedHost(sendEvents()), manager);

  const approval = await manager.authorizeHostPermission({
    missionId: "mission-side-effect-host",
    title: "Host tool permission",
    reason: "send message",
    details: {
      workItemId: "work-1",
      attemptId: "attempt-1",
      executionId: "execution-1",
      toolCall: {
        toolCallId: "send-1",
        title: "Send message",
        kind: "send",
        rawInput: { recipient: "a@example.test", body: "hello" }
      }
    }
  });
  assert.equal(approval.approved, true);

  const handle = await host.createAgent(request());
  const observed: HostAgentEvent[] = [];
  for await (const event of host.observeAgent(handle)) observed.push(event);

  assert.equal(observed.at(-1)?.type, "completed");
  assert.ok(observed.some(event => event.type === "tool" && JSON.stringify(event.payload).includes("mission_side_effect_receipt")));
  assert.ok(store.events.some(event => event.type === "side_effect.completed"));
  const completion = store.events.find(event => event.type === "side_effect.completed")?.payload as { status?: string };
  assert.equal(completion.status, "succeeded");
});

test("cancelling a host session releases its runtime-owned side-effect scope", async () => {
  const store = new MemoryEventStore();
  const manager = new RuntimeSideEffectManager(store, new ApprovalBroker());
  const host = new SideEffectHostAdapter(new ScriptedHost([]), manager);

  const first = await host.createAgent(request());
  await host.cancelAgent(first);

  await assert.doesNotReject(() => host.createAgent(request({
    attemptId: "attempt-2",
    executionId: "execution-2"
  })));
});
