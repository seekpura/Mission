import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { SideEffectIntent, SideEffectPolicy } from "../../src/core/domain/execution.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import type { ApprovalRequest, ApprovalResult } from "../../src/hosts/host-adapter.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import {
  RuntimeSideEffectManager,
  type SideEffectApprovalBroker,
  type SideEffectApprovalRequest
} from "../../src/runtime/side-effect-manager.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class ApprovalBroker implements SideEffectApprovalBroker {
  async requestHostApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: true, scope: "once" };
  }

  async requestSideEffectApproval(_request: SideEffectApprovalRequest): Promise<{ approved: boolean }> {
    return { approved: true };
  }
}

class NoListEventStore implements EventStore {
  readonly inner: SqliteEventStore;
  listCalls = 0;

  constructor(inner: SqliteEventStore) {
    this.inner = inner;
  }

  append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    return this.inner.append(event, expectedSequence);
  }

  async list(_missionId: string, _afterSequence = 0): Promise<MissionEvent[]> {
    this.listCalls += 1;
    throw new Error("event-log scan must not be used when side-effect history reader is configured");
  }

  lastSequence(missionId: string): Promise<number> {
    return this.inner.lastSequence(missionId);
  }
}

const allowExternalWrites: SideEffectPolicy = {
  externalWrites: "allow",
  destructiveWrites: "deny",
  irreversibleActions: "deny",
  idempotencyRequired: true
};

function intent(missionId: string, operationKey: string): SideEffectIntent {
  return {
    id: `intent:${operationKey}`,
    missionId,
    workItemId: "work-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    source: "runtime-action",
    operationKey,
    fingerprint: `fingerprint:${operationKey}`,
    effectClass: "external-write",
    type: "external-write",
    target: "https://example.invalid/write",
    reversible: true,
    description: "write external state",
    createdAt: "2026-10-29T05:00:00.000Z"
  };
}

test("RuntimeSideEffectManager uses the dedicated operational projection instead of scanning Mission events", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const sqliteEvents = new SqliteEventStore(database);
  const events = new NoListEventStore(sqliteEvents);
  const reader = new SqliteMissionReader(database);
  const manager = new RuntimeSideEffectManager(events, new ApprovalBroker(), { historyReader: reader });
  const missionId = "mission-side-effect-hot-path";
  const value = intent(missionId, "operation-hot-path");

  try {
    const first = await manager.authorize(value, allowExternalWrites);
    assert.equal(first.admission.status, "admitted");

    const completion = await manager.complete(value, "succeeded", "fixture completed");
    assert.equal(completion.status, "succeeded");

    const replay = await manager.authorize(value, allowExternalWrites);
    assert.equal(replay.admission.status, "replay_blocked");
    assert.equal(events.listCalls, 0);

    const views = reader.readSideEffects(missionId, { operationKey: value.operationKey, limit: 1 });
    assert.equal(views.length, 1);
    assert.equal(views[0]?.status, "succeeded");
    assert.equal(views[0]?.admission?.status, "admitted");
    assert.equal(views[0]?.completion?.status, "succeeded");
    assert.equal(views[0]?.replayBlockCount, 1);
    assert.equal(views[0]?.lastReplayBlocked?.status, "replay_blocked");
  } finally {
    database.close();
  }
});

test("configured side-effect history reader failure fails closed without event-log fallback", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const sqliteEvents = new SqliteEventStore(database);
  const events = new NoListEventStore(sqliteEvents);
  const manager = new RuntimeSideEffectManager(events, new ApprovalBroker(), {
    historyReader: {
      readSideEffects() {
        throw new Error("side-effect projection unavailable");
      }
    }
  });
  const missionId = "mission-side-effect-reader-failure";

  try {
    await assert.rejects(
      () => manager.authorize(intent(missionId, "operation-reader-failure"), allowExternalWrites),
      /side-effect projection unavailable/
    );
    assert.equal(events.listCalls, 0);
    assert.equal(await sqliteEvents.lastSequence(missionId), 0);
  } finally {
    database.close();
  }
});
