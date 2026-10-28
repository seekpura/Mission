import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import type { CapabilityRuntime, CapabilityEnsureResult } from "../../src/core/capabilities/capability-coordinator.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { RuntimeCapabilityLifecycleManager } from "../../src/runtime/capability-ledger-runtime.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function listen(server: ReturnType<typeof createMissionApi>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createMissionApi>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

class LifecycleRuntime implements CapabilityRuntime {
  readonly deactivated: Array<{ missionId: string; capabilityId: string }> = [];
  restoreMissionCapabilities(): void {}
  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.deactivated.push({ missionId, capabilityId });
  }
  async ensure(): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "not used" };
  }
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
    createdAt: new Date().toISOString()
  }, expected);
}

function capability(): CapabilityDescriptor {
  return {
    id: "capability-api-1",
    kind: "skill",
    name: "api-skill",
    description: "Capability lifecycle API fixture",
    hostNative: false,
    available: true,
    permissions: [],
    revision: "commit-api-1",
    scope: "mission",
    functions: ["api.test"],
    provenance: {
      source: "trusted-cache",
      sourceRef: "https://github.com/example/api-skill",
      revision: "commit-api-1",
      contentHash: `sha256:${"c".repeat(64)}`
    }
  };
}

function resolutionEnvelope(missionId: string, capabilityId: string) {
  return {
    trust: {
      id: "trust-api-1",
      missionId,
      capabilityNeedId: "need-api-1",
      capabilityId,
      trustLevel: "trusted-cache",
      provenanceSource: "trusted-cache",
      cacheKey: "cache-api-1",
      reusable: true,
      reason: "fixture",
      recordedAt: "2026-10-29T00:00:00.000Z"
    },
    cost: {
      id: "cost-api-1",
      missionId,
      capabilityNeedId: "need-api-1",
      capabilityId,
      phase: "acquisition",
      monetaryClass: "unknown",
      latencyClass: "unknown",
      source: "unknown",
      recordedAt: "2026-10-29T00:00:01.000Z"
    },
    audit: {
      id: "audit-api-1",
      missionId,
      capabilityNeedId: "need-api-1",
      capabilityId,
      decision: "trusted-cache-reused",
      resolutionSource: "trusted-cache",
      trustRecordId: "trust-api-1",
      costRecordId: "cost-api-1",
      cacheKey: "cache-api-1",
      reason: "fixture",
      attempts: [],
      recordedAt: "2026-10-29T00:00:02.000Z"
    }
  };
}

test("Mission API exposes capability ledger and applies durable deactivate/revoke lifecycle", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const baseRuntime = new LifecycleRuntime();
  const lifecycle = new RuntimeCapabilityLifecycleManager(baseRuntime, events);
  const server = createMissionApi(controller, events, {
    capabilityLifecycle: lifecycle,
    capabilityLedgerReader: reader
  });

  try {
    const missionId = "mission-capability-api";
    await controller.createMission(missionId, "exercise capability lifecycle API");
    const fixture = capability();
    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-api-1", capability: fixture });
    await append(events, missionId, "capability.resolution.recorded", resolutionEnvelope(missionId, fixture.id));
    const base = await listen(server);

    const ledgerResponse = await fetch(`${base}/missions/${missionId}/capabilities/ledger`);
    assert.equal(ledgerResponse.status, 200);
    const ledger = await ledgerResponse.json() as any;
    assert.equal(ledger.trust.length, 1);
    assert.equal(ledger.costs.length, 1);
    assert.equal(ledger.audit.length, 1);
    assert.equal(ledger.audit[0].decision, "trusted-cache-reused");

    const missingReason = await fetch(`${base}/missions/${missionId}/capabilities/${encodeURIComponent(fixture.id)}/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({})
    });
    assert.equal(missingReason.status, 400);

    const deactivateResponse = await fetch(`${base}/missions/${missionId}/capabilities/${encodeURIComponent(fixture.id)}/deactivate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "operator disabled capability" })
    });
    assert.equal(deactivateResponse.status, 200);
    const deactivateBody = await deactivateResponse.json() as any;
    assert.equal(deactivateBody.status, "deactivated");
    assert.equal((await reader.journal(missionId)).capabilities.has(fixture.id), false);
    assert.deepEqual(baseRuntime.deactivated, [{ missionId, capabilityId: fixture.id }]);
    assert.equal(reader.readCapabilityAudit(missionId).at(-1)?.decision, "deactivated");

    await append(events, missionId, "capability.activated", { capabilityNeedId: "need-api-1", capability: fixture });
    const revokeResponse = await fetch(`${base}/missions/${missionId}/capabilities/${encodeURIComponent(fixture.id)}/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "trust withdrawn" })
    });
    assert.equal(revokeResponse.status, 200);
    const revokeBody = await revokeResponse.json() as any;
    assert.equal(revokeBody.status, "revoked");
    assert.equal((await reader.journal(missionId)).capabilities.has(fixture.id), false);
    assert.deepEqual(baseRuntime.deactivated, [
      { missionId, capabilityId: fixture.id },
      { missionId, capabilityId: fixture.id }
    ]);
    assert.equal(reader.readCapabilityTrust(missionId).at(-1)?.trustLevel, "revoked");
    assert.equal(reader.readCapabilityAudit(missionId).at(-1)?.decision, "revoked");
  } finally {
    await closeServer(server);
    database.close();
  }
});
