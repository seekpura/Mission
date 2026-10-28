import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import type {
  CapabilityAuditRecord,
  CapabilityCostRecord,
  CapabilityTrustRecord
} from "../../src/core/domain/capability-ledger.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function setup() {
  const database = new MissionDatabase(":memory:");
  database.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  return {
    database,
    events: new SqliteEventStore(database),
    reader: new SqliteMissionReader(database)
  };
}

async function append(events: SqliteEventStore, missionId: string, type: any, payload: unknown): Promise<void> {
  const expected = await events.lastSequence(missionId);
  await events.append({
    id: `${type}:${expected + 1}`,
    missionId,
    type,
    actor: { type: "system", id: "test" },
    payload,
    schemaVersion: 1,
    createdAt: `2026-10-29T00:00:0${expected}.000Z`
  }, expected);
}

test("capability trust, cost and audit events are queryable durable read models", async () => {
  const { database, events, reader } = setup();
  try {
    const missionId = "mission-capability-ledger-read";
    const trust: CapabilityTrustRecord = {
      id: "trust-1",
      missionId,
      capabilityNeedId: "need-1",
      capabilityId: "capability-1",
      trustLevel: "trusted-cache",
      provenanceSource: "trusted-cache",
      identity: {
        sourceType: "github",
        sourceUri: "https://github.com/example/skill",
        resolvedRevision: "commit-1",
        contentHash: `sha256:${"a".repeat(64)}`
      },
      cacheKey: "cache-1",
      reusable: true,
      reason: "exact bytes reused",
      recordedAt: "2026-10-29T00:00:00.000Z"
    };
    const cost: CapabilityCostRecord = {
      id: "cost-1",
      missionId,
      capabilityNeedId: "need-1",
      capabilityId: "capability-1",
      phase: "acquisition",
      monetaryClass: "low",
      latencyClass: "interactive",
      metered: false,
      source: "capability-declared",
      recordedAt: "2026-10-29T00:00:01.000Z"
    };
    const audit: CapabilityAuditRecord = {
      id: "audit-1",
      missionId,
      capabilityNeedId: "need-1",
      capabilityId: "capability-1",
      decision: "trusted-cache-reused",
      resolutionSource: "trusted-cache",
      trustRecordId: trust.id,
      costRecordId: cost.id,
      cacheKey: "cache-1",
      reason: "reuse",
      attempts: [],
      recordedAt: "2026-10-29T00:00:02.000Z"
    };

    await append(events, missionId, "capability.trust.recorded", trust);
    await append(events, missionId, "capability.cost.recorded", cost);
    await append(events, missionId, "capability.audit.recorded", audit);

    assert.deepEqual(reader.readCapabilityTrust(missionId), [trust]);
    assert.deepEqual(reader.readCapabilityCosts(missionId), [cost]);
    assert.deepEqual(reader.readCapabilityAudit(missionId), [audit]);
  } finally {
    database.close();
  }
});

test("capability deactivation and revocation remove capabilities from restart journal projection", async () => {
  const { database, events, reader } = setup();
  try {
    const missionId = "mission-capability-lifecycle-read";
    const capability: CapabilityDescriptor = {
      id: "capability-1",
      kind: "skill",
      name: "skill-one",
      description: "test skill",
      hostNative: false,
      available: true,
      permissions: [],
      scope: "mission",
      functions: ["test.function"],
      cost: { monetaryClass: "free", latencyClass: "instant", metered: false },
      provenance: { source: "mission", revision: "r1", contentHash: `sha256:${"b".repeat(64)}` }
    };

    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-1", capability });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), true);

    await append(events, missionId, "capability.deactivated", { capabilityId: capability.id, reason: "disabled" });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), false);

    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-1", capability });
    await append(events, missionId, "capability.revoked", { capabilityId: capability.id, reason: "revoked" });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), false);
  } finally {
    database.close();
  }
});
