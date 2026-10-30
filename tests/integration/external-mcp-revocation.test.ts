import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";
import { RuntimeCapabilityLifecycleManager } from "../../src/runtime/capability-ledger-runtime.ts";
import { ExternalMcpAdmissionRuntime } from "../../src/runtime/external-mcp-admission.ts";
import { ExternalMcpCatalogDiscoveryProvider } from "../../src/runtime/external-mcp-catalog.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class MissingRuntime implements CapabilityRuntime {
  private readonly overlay: MissionCapabilityOverlay;

  constructor(overlay: MissionCapabilityOverlay) {
    this.overlay = overlay;
  }

  restoreMissionCapabilities(missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    for (const capability of capabilities) {
      if (!capability.hostNative && capability.available) this.overlay.activate(missionId, capability);
    }
  }

  deactivateMissionCapability(missionId: string, capabilityId: string): void {
    this.overlay.deactivate(missionId, capabilityId);
  }

  async ensure(): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "no existing capability" };
  }
}

const catalog = new ExternalMcpCatalogDiscoveryProvider([{
  id: "vendor-docs",
  name: "vendor_docs",
  description: "External vendor documentation MCP",
  revision: "2026-10-31.r1",
  url: "https://mcp.example.test/mcp",
  functions: ["search vendor docs"],
  accepts: ["query"],
  produces: ["documentation"]
}]);

function need(): CapabilityNeed {
  return {
    id: "need-external-docs",
    missionId: "mission-external-mcp-revocation",
    objective: "search vendor docs",
    requiredFunctions: ["search vendor docs"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "high",
    policy: { acceptableKinds: ["mcp"] },
    requirementRefs: [],
    gapRefs: []
  };
}

async function waitForPending(manager: RuntimeApprovalManager) {
  let pending = await manager.listPending(need().missionId);
  for (let attempt = 0; pending.length === 0 && attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    pending = await manager.listPending(need().missionId);
  }
  return pending;
}

function admission(
  approvals: RuntimeApprovalManager,
  overlay: MissionCapabilityOverlay,
  reader: SqliteMissionReader
): ExternalMcpAdmissionRuntime {
  return new ExternalMcpAdmissionRuntime({
    base: new MissingRuntime(overlay),
    catalog,
    approvals,
    revocations: reader
  });
}

test("durably revoked external MCP identity cannot reuse an old approval to reacquire", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  let approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });

  try {
    await controller.createMission(need().missionId, "prove revoked external MCP stays revoked");
    const overlay = new MissionCapabilityOverlay();
    const runtime = admission(approvals, overlay, reader);
    const firstEnsure = runtime.ensure(need());
    const pending = await waitForPending(approvals);
    assert.equal(pending.length, 1);
    await approvals.decide(need().missionId, pending[0]!.id, {
      approved: true,
      scope: "once",
      actor: "user:test"
    });
    const first = await firstEnsure;
    assert.equal(first.status, "resolved");
    assert(first.capability);
    const capability = first.capability;

    await events.append({
      id: "external-mcp-revocation-activation",
      missionId: need().missionId,
      type: "capability.activated",
      actor: { type: "controller" },
      payload: {
        capabilityNeedId: need().id,
        capability,
        source: "acquired",
        reason: "approved external MCP fixture",
        attempts: []
      },
      idempotencyKey: `capability-activated:${need().id}:${capability.id}:${capability.revision}`,
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    }, await events.lastSequence(need().missionId));
    runtime.restoreMissionCapabilities(need().missionId, (await reader.journal(need().missionId)).capabilities.values());

    const lifecycle = new RuntimeCapabilityLifecycleManager(runtime, events);
    await lifecycle.deactivate({
      missionId: need().missionId,
      capabilityId: capability.id,
      reason: "operator revoked compromised external endpoint identity",
      revoked: true
    });
    assert.equal(reader.isCapabilityRevoked(need().missionId, capability.id), true);
    assert.equal((await reader.journal(need().missionId)).capabilities.has(capability.id), false);

    approvals.dispose();
    approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });
    const restarted = admission(approvals, new MissionCapabilityOverlay(), reader);
    const retry = await Promise.race([
      restarted.ensure(need()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("revoked external MCP prompted again")), 100))
    ]);
    assert.equal(retry.status, "acquisition_failed");
    assert.match(retry.reason, /revoked/i);
    assert.equal(retry.capability, undefined);

    const approvalEvents = (await events.list(need().missionId)).filter(event =>
      event.type === "approval.requested" || event.type === "approval.decided"
    );
    assert.equal(approvalEvents.filter(event => event.type === "approval.requested").length, 1);
    assert.equal(approvalEvents.filter(event => event.type === "approval.decided").length, 1);
  } finally {
    approvals.dispose();
    database.close();
  }
});
