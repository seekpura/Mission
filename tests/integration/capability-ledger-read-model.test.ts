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

function resolutionLedger(missionId: string) {
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
  return { trust, cost, audit };
}

test("one capability resolution event atomically projects queryable trust, cost and audit read models", async () => {
  const { database, events, reader } = setup();
  try {
    const missionId = "mission-capability-ledger-read";
    const envelope = resolutionLedger(missionId);

    await append(events, missionId, "capability.resolution.recorded", envelope);

    assert.equal((await events.list(missionId)).length, 1);
    assert.deepEqual(reader.readCapabilityTrust(missionId), [envelope.trust]);
    assert.deepEqual(reader.readCapabilityCosts(missionId), [envelope.cost]);
    assert.deepEqual(reader.readCapabilityAudit(missionId), [envelope.audit]);
  } finally {
    database.close();
  }
});

test("malformed atomic capability resolution rolls back the event and every ledger projection", async () => {
  const { database, events, reader } = setup();
  try {
    const missionId = "mission-capability-ledger-rollback";
    const envelope = resolutionLedger(missionId);

    await assert.rejects(() => append(events, missionId, "capability.resolution.recorded", {
      trust: envelope.trust,
      cost: envelope.cost,
      audit: { ...envelope.audit, decision: "" }
    }), /Missing decision/);

    assert.equal((await events.list(missionId)).length, 0);
    assert.deepEqual(reader.readCapabilityTrust(missionId), []);
    assert.deepEqual(reader.readCapabilityCosts(missionId), []);
    assert.deepEqual(reader.readCapabilityAudit(missionId), []);
  } finally {
    database.close();
  }
});

test("capability deactivation and revocation atomically remove restart capability state and project lifecycle audit/trust", async () => {
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
      cost: { monetaryClass: "negligible", latencyClass: "local", metered: false },
      provenance: { source: "mission", revision: "r1", contentHash: `sha256:${"b".repeat(64)}` }
    };

    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-1", capability });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), true);

    const deactivatedAudit: CapabilityAuditRecord = {
      id: "audit-deactivated",
      missionId,
      capabilityId: capability.id,
      decision: "deactivated",
      resolutionSource: "none",
      reason: "disabled",
      attempts: [],
      recordedAt: "2026-10-29T00:00:03.000Z"
    };
    await append(events, missionId, "capability.deactivated", {
      capabilityId: capability.id,
      reason: "disabled",
      audit: deactivatedAudit
    });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), false);
    assert.deepEqual(reader.readCapabilityAudit(missionId), [deactivatedAudit]);

    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-1", capability });
    const revokedTrust: CapabilityTrustRecord = {
      id: "trust-revoked",
      missionId,
      capabilityNeedId: "lifecycle",
      capabilityId: capability.id,
      trustLevel: "revoked",
      provenanceSource: "unknown",
      reusable: false,
      reason: "revoked",
      recordedAt: "2026-10-29T00:00:04.000Z"
    };
    const revokedAudit: CapabilityAuditRecord = {
      id: "audit-revoked",
      missionId,
      capabilityId: capability.id,
      decision: "revoked",
      resolutionSource: "none",
      reason: "revoked",
      attempts: [],
      recordedAt: "2026-10-29T00:00:04.000Z"
    };
    await append(events, missionId, "capability.revoked", {
      capabilityId: capability.id,
      reason: "revoked",
      audit: revokedAudit,
      revokedTrust
    });
    assert.equal((await reader.journal(missionId)).capabilities.has(capability.id), false);
    assert.deepEqual(reader.readCapabilityTrust(missionId), [revokedTrust]);
    assert.deepEqual(reader.readCapabilityAudit(missionId), [deactivatedAudit, revokedAudit]);
  } finally {
    database.close();
  }
});
