import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import type {
  CapabilityEnsureResult,
  CapabilityRuntime
} from "../../src/core/capabilities/capability-coordinator.ts";
import {
  CapabilityLedgerRuntime,
  RuntimeCapabilityLifecycleManager
} from "../../src/runtime/capability-ledger-runtime.ts";

class MemoryEventStore implements EventStore {
  readonly events: MissionEvent[] = [];
  failAppends = false;

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    if (this.failAppends) throw new Error("ledger storage unavailable");
    const scoped = this.events.filter(item => item.missionId === event.missionId);
    const duplicate = event.idempotencyKey
      ? scoped.find(item => item.idempotencyKey === event.idempotencyKey)
      : undefined;
    if (duplicate) return duplicate as MissionEvent<T>;
    if (scoped.length !== expectedSequence) {
      const error = new Error(`expected ${expectedSequence}, actual ${scoped.length}`);
      error.name = "ConcurrencyConflictError";
      throw error;
    }
    const committed = { ...event, sequence: scoped.length + 1 } as MissionEvent<T>;
    this.events.push(committed as MissionEvent);
    return committed;
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    return this.events.filter(event => event.missionId === missionId && event.sequence > afterSequence);
  }

  async lastSequence(missionId: string): Promise<number> {
    return this.events.filter(event => event.missionId === missionId).length;
  }
}

class FakeCapabilityRuntime implements CapabilityRuntime {
  result: CapabilityEnsureResult;
  deactivated: Array<{ missionId: string; capabilityId: string }> = [];

  constructor(result: CapabilityEnsureResult) { this.result = result; }
  restoreMissionCapabilities(): void {}
  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.deactivated.push({ missionId, capabilityId });
  }
  async ensure(): Promise<CapabilityEnsureResult> { return structuredClone(this.result); }
}

function need(): CapabilityNeed {
  return {
    id: "need-1",
    missionId: "mission-ledger",
    objective: "render a presentation",
    requiredFunctions: ["presentation.render"],
    desiredInputs: ["document"],
    desiredOutputs: ["presentation"],
    purpose: "production",
    urgency: "high",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: ["req-1"],
    gapRefs: []
  };
}

function capability(): CapabilityDescriptor {
  return {
    id: "acquired:presentation-renderer",
    kind: "skill",
    name: "presentation-renderer",
    description: "Render presentations",
    hostNative: false,
    available: true,
    permissions: [],
    revision: "commit-1",
    scope: "mission",
    functions: ["presentation.render"],
    accepts: ["document"],
    produces: ["presentation"],
    cost: {
      monetaryClass: "low",
      latencyClass: "interactive",
      metered: false
    },
    provenance: {
      source: "trusted-cache",
      sourceRef: "https://github.com/example/presentation-renderer",
      revision: "commit-1",
      contentHash: `sha256:${"a".repeat(64)}`
    }
  };
}

test("CapabilityLedgerRuntime durably records trust, declared cost and audit evidence before returning resolved", async () => {
  const store = new MemoryEventStore();
  const base = new FakeCapabilityRuntime({
    status: "resolved",
    capability: capability(),
    source: "trusted-cache",
    attempts: [{ candidateId: "candidate-1", candidateName: "renderer", ok: true }],
    reason: "reused exact trusted bytes",
    evidence: {
      provenanceSource: "trusted-cache",
      sourceType: "github",
      sourceUri: "https://github.com/example/presentation-renderer",
      resolvedRevision: "commit-1",
      contentHash: `sha256:${"a".repeat(64)}`,
      acquisitionReceiptId: "receipt-1",
      acquisitionStatus: "activated_from_trusted_cache",
      candidateId: "candidate-1",
      securityRisk: "low",
      cacheKey: "cache-1"
    }
  });
  const runtime = new CapabilityLedgerRuntime(base, store);

  const result = await runtime.ensure(need());

  assert.equal(result.status, "resolved");
  assert.deepEqual(store.events.map(event => event.type), [
    "capability.trust.recorded",
    "capability.cost.recorded",
    "capability.audit.recorded"
  ]);
  const trust = store.events[0]?.payload as Record<string, any>;
  assert.equal(trust.trustLevel, "trusted-cache");
  assert.equal(trust.identity.sourceUri, "https://github.com/example/presentation-renderer");
  assert.equal(trust.securityRisk, "low");
  assert.equal(trust.reusable, true);
  const cost = store.events[1]?.payload as Record<string, any>;
  assert.equal(cost.monetaryClass, "low");
  assert.equal(cost.latencyClass, "interactive");
  assert.equal(cost.amount, undefined);
  const audit = store.events[2]?.payload as Record<string, any>;
  assert.equal(audit.decision, "trusted-cache-reused");
  assert.equal(audit.trustRecordId, trust.id);
  assert.equal(audit.costRecordId, cost.id);
});

test("CapabilityLedgerRuntime records failed resolution decisions", async () => {
  const store = new MemoryEventStore();
  const runtime = new CapabilityLedgerRuntime(new FakeCapabilityRuntime({
    status: "acquisition_failed",
    source: "none",
    attempts: [{ candidateId: "candidate-bad", candidateName: "bad", ok: false, reason: "blocked" }],
    reason: "no safe capability"
  }), store);

  const result = await runtime.ensure(need());

  assert.equal(result.status, "acquisition_failed");
  assert.deepEqual(store.events.map(event => event.type), ["capability.audit.recorded"]);
  assert.equal((store.events[0]?.payload as Record<string, any>).decision, "rejected");
});

test("CapabilityLedgerRuntime deactivates a resolved capability if durable ledger commit fails", async () => {
  const store = new MemoryEventStore();
  store.failAppends = true;
  const base = new FakeCapabilityRuntime({
    status: "resolved",
    capability: capability(),
    source: "host-or-overlay",
    attempts: [],
    reason: "already available",
    evidence: { provenanceSource: "mission" }
  });
  const runtime = new CapabilityLedgerRuntime(base, store);

  const result = await runtime.ensure(need());

  assert.equal(result.status, "acquisition_failed");
  assert.match(result.reason, /ledger commit failed/);
  assert.deepEqual(base.deactivated, [{ missionId: "mission-ledger", capabilityId: "acquired:presentation-renderer" }]);
});

test("RuntimeCapabilityLifecycleManager durably deactivates and revokes mission capability trust", async () => {
  const store = new MemoryEventStore();
  const base = new FakeCapabilityRuntime({
    status: "missing",
    source: "none",
    attempts: [],
    reason: "unused"
  });
  const manager = new RuntimeCapabilityLifecycleManager(base, store);

  await manager.deactivate({
    missionId: "mission-ledger",
    capabilityId: "capability-1",
    reason: "operator disabled capability"
  });
  await manager.deactivate({
    missionId: "mission-ledger",
    capabilityId: "capability-2",
    reason: "trust revoked",
    revoked: true
  });

  assert.deepEqual(base.deactivated, [
    { missionId: "mission-ledger", capabilityId: "capability-1" },
    { missionId: "mission-ledger", capabilityId: "capability-2" }
  ]);
  assert.deepEqual(store.events.map(event => event.type), [
    "capability.deactivated",
    "capability.audit.recorded",
    "capability.revoked",
    "capability.trust.recorded",
    "capability.audit.recorded"
  ]);
  const revokedTrust = store.events.find(event => event.type === "capability.trust.recorded")?.payload as Record<string, any>;
  assert.equal(revokedTrust.trustLevel, "revoked");
  assert.equal(revokedTrust.reusable, false);
});
