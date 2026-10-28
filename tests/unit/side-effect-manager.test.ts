import test from "node:test";
import assert from "node:assert/strict";
import type { SideEffectIntent, SideEffectPolicy } from "../../src/core/domain/execution.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import {
  RuntimeSideEffectManager,
  evaluatePolicy,
  type SideEffectApprovalBroker,
  type SideEffectApprovalRequest
} from "../../src/runtime/side-effect-manager.ts";
import type { ApprovalRequest, ApprovalResult } from "../../src/hosts/deepseek/host-adapter.ts";

class MemoryEventStore implements EventStore {
  readonly events: MissionEvent[] = [];

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const current = this.events.filter(item => item.missionId === event.missionId).length;
    const duplicate = event.idempotencyKey
      ? this.events.find(item => item.missionId === event.missionId && item.idempotencyKey === event.idempotencyKey)
      : undefined;
    if (duplicate) return duplicate as MissionEvent<T>;
    if (current !== expectedSequence) throw new Error(`Concurrency conflict: expected sequence ${expectedSequence}, actual ${current}`);
    const stored = { ...event, sequence: current + 1 } as MissionEvent<T>;
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
  hostRequests: ApprovalRequest[] = [];
  sideEffectRequests: SideEffectApprovalRequest[] = [];
  sideEffectApproved = true;

  async requestHostApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    this.hostRequests.push(request);
    return { approved: true, scope: "once" };
  }

  async requestSideEffectApproval(request: SideEffectApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    this.sideEffectRequests.push(request);
    return { approved: this.sideEffectApproved, ...(this.sideEffectApproved ? { actor: "user" } : {}) };
  }
}

const approvalPolicy: SideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "approval",
  idempotencyRequired: true
};

function intent(overrides: Partial<SideEffectIntent> = {}): SideEffectIntent {
  return {
    id: "side-effect:test",
    missionId: "mission-side-effect",
    workItemId: "work-1",
    source: "runtime-action",
    operationKey: "operation:test",
    fingerprint: "fingerprint-a",
    effectClass: "irreversible-action",
    type: "message",
    target: "recipient@example.test",
    reversible: false,
    description: "send a message",
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides
  };
}

test("policy evaluation fails closed for destructive and irreversible effects", () => {
  assert.equal(evaluatePolicy(intent({ effectClass: "external-write" }), { ...approvalPolicy, externalWrites: "allow" }), "allow");
  assert.equal(evaluatePolicy(intent({ effectClass: "external-write" }), { ...approvalPolicy, externalWrites: "deny" }), "deny");
  assert.equal(evaluatePolicy(intent({ effectClass: "destructive-write" }), approvalPolicy), "approval");
  assert.equal(evaluatePolicy(intent({ effectClass: "irreversible-action" }), approvalPolicy), "approval");
  assert.equal(evaluatePolicy(intent({ effectClass: "unknown-effect" }), { ...approvalPolicy, irreversibleActions: "deny" }), "deny");
});

test("authorized irreversible effect is durably admitted once and duplicate replay is blocked", async () => {
  const store = new MemoryEventStore();
  const broker = new ApprovalBroker();
  const manager = new RuntimeSideEffectManager(store, broker);

  const first = await manager.authorize(intent(), approvalPolicy);
  assert.equal(first.admission.status, "admitted");
  assert.equal(first.admission.approvalRequired, true);
  assert.equal(broker.sideEffectRequests.length, 1);
  assert.deepEqual(store.events.map(event => event.type), [
    "side_effect.intent.recorded",
    "side_effect.admitted"
  ]);

  const duplicate = await manager.authorize(intent(), approvalPolicy);
  assert.equal(duplicate.admission.status, "replay_blocked");
  assert.equal(broker.sideEffectRequests.length, 1);
  assert.ok(store.events.some(event => event.type === "side_effect.replay_blocked"));
});

test("operation-key fingerprint conflict is blocked without a second approval", async () => {
  const store = new MemoryEventStore();
  const broker = new ApprovalBroker();
  const manager = new RuntimeSideEffectManager(store, broker);

  assert.equal((await manager.authorize(intent(), approvalPolicy)).admission.status, "admitted");
  const conflict = await manager.authorize(intent({ fingerprint: "different-fingerprint", target: "other@example.test" }), approvalPolicy);
  assert.equal(conflict.admission.status, "replay_blocked");
  assert.match(conflict.admission.reason, /different side-effect fingerprint/);
  assert.equal(broker.sideEffectRequests.length, 1);
});

test("host read permission delegates to normal host approval while irreversible host tool uses side-effect approval", async () => {
  const store = new MemoryEventStore();
  const broker = new ApprovalBroker();
  const manager = new RuntimeSideEffectManager(store, broker);

  const readResult = await manager.authorizeHostPermission({
    missionId: "mission-side-effect",
    title: "Host tool permission",
    reason: "read file",
    details: {
      workItemId: "work-1",
      toolCall: { toolCallId: "read-1", title: "Read file", kind: "read", rawInput: { path: "notes.txt" } }
    }
  });
  assert.equal(readResult.approved, true);
  assert.equal(broker.hostRequests.length, 1);
  assert.equal(broker.sideEffectRequests.length, 0);

  const sendResult = await manager.authorizeHostPermission({
    missionId: "mission-side-effect",
    title: "Host tool permission",
    reason: "send message",
    details: {
      workItemId: "work-1",
      toolCall: { toolCallId: "send-1", title: "Send message", kind: "send", rawInput: { recipient: "a@example.test", body: "secret body is hashed, not persisted in intent" } }
    }
  });
  assert.equal(sendResult.approved, true);
  assert.equal(broker.sideEffectRequests.length, 1);
  const recorded = store.events.find(event => event.type === "side_effect.intent.recorded")?.payload as SideEffectIntent;
  assert.equal(recorded.metadata?.toolCallId, "send-1");
  assert.equal(JSON.stringify(recorded).includes("secret body"), false);
});

test("host side-effect replay keys are stable within one execution but isolated across new executions", async () => {
  const store = new MemoryEventStore();
  const broker = new ApprovalBroker();
  const manager = new RuntimeSideEffectManager(store, broker);
  const request = (executionId: string, attemptId: string): ApprovalRequest => ({
    missionId: "mission-side-effect",
    title: "Host tool permission",
    reason: "send message",
    details: {
      workItemId: "work-1",
      attemptId,
      executionId,
      sideEffectPolicy: approvalPolicy,
      toolCall: {
        toolCallId: "call-1",
        title: "Send message",
        kind: "send",
        rawInput: { recipient: "same@example.test", body: "same payload" }
      }
    }
  });

  const first = await manager.authorizeHostPermission(request("execution-1", "attempt-1"));
  const replay = await manager.authorizeHostPermission(request("execution-1", "attempt-1"));
  const nextExecution = await manager.authorizeHostPermission(request("execution-2", "attempt-2"));

  assert.equal(first.approved, true);
  assert.equal(replay.approved, false);
  assert.equal(nextExecution.approved, true);
  assert.equal(broker.sideEffectRequests.length, 2);

  const intents = store.events
    .filter(event => event.type === "side_effect.intent.recorded")
    .map(event => event.payload as SideEffectIntent);
  assert.equal(intents.length, 2);
  assert.notEqual(intents[0]?.operationKey, intents[1]?.operationKey);
  assert.match(intents[0]?.operationKey ?? "", /execution-1/);
  assert.match(intents[1]?.operationKey ?? "", /execution-2/);
});
