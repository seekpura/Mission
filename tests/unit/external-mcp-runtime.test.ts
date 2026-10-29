import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type { AcquisitionReceipt, AcquisitionReceiptStore } from "../../src/core/capabilities/acquisition-receipt.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import {
  ExternalMcpAcquirer,
  ExternalMcpCapabilityRuntime,
  ExternalMcpCatalog,
  MissionExternalMcpRegistry,
  parseExternalMcpCatalogJson
} from "../../src/runtime/external-mcp-runtime.ts";

class MemoryReceipts implements AcquisitionReceiptStore {
  readonly receipts: AcquisitionReceipt[] = [];
  save(receipt: AcquisitionReceipt): void { this.receipts.push(structuredClone(receipt)); }
  list(missionId: string): AcquisitionReceipt[] { return this.receipts.filter(receipt => receipt.missionId === missionId); }
}

class MissingRuntime implements CapabilityRuntime {
  restored: CapabilityDescriptor[] = [];
  deactivated: string[] = [];
  restoreMissionCapabilities(_missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    this.restored = [...capabilities];
  }
  deactivateMissionCapability(_missionId: string, capabilityId: string): void { this.deactivated.push(capabilityId); }
  async ensure(_need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "not present in host or overlay" };
  }
}

function need(maxRisk: CapabilityNeed["maxRisk"] = "high"): CapabilityNeed {
  return {
    id: "need-docs-mcp",
    missionId: "mission-external-mcp",
    objective: "search vendor documentation through a remote MCP server",
    requiredFunctions: ["search vendor docs"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk,
    policy: { acceptableKinds: ["mcp"] },
    requirementRefs: [],
    gapRefs: []
  };
}

const entries = [{
  id: "vendor-docs",
  name: "vendor_docs",
  description: "Vendor documentation search MCP",
  revision: "2026-10-29",
  url: "https://mcp.example.test/mcp",
  functions: ["search vendor docs", "retrieve vendor docs"],
  accepts: ["query"],
  produces: ["documentation"]
}];

test("external MCP catalog is immutable-hash discoverable and rejects credential-like URL shapes", () => {
  const catalog = new ExternalMcpCatalog(entries);
  const ranked = catalog.discover(need());
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.candidate.candidateKind, "mcp");
  assert.equal(ranked[0]?.candidate.sourceType, "mcp-registry");
  assert.match(ranked[0]?.candidate.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);

  assert.throws(
    () => parseExternalMcpCatalogJson(JSON.stringify([{ ...entries[0], url: "https://user:secret@mcp.example.test/mcp" }])),
    /must not contain credentials/
  );
  assert.throws(
    () => parseExternalMcpCatalogJson(JSON.stringify([{ ...entries[0], url: "https://mcp.example.test/mcp?token=secret" }])),
    /query parameters/
  );
  assert.throws(
    () => parseExternalMcpCatalogJson(JSON.stringify([{ ...entries[0], url: "http://mcp.example.test/mcp" }])),
    /requires HTTPS/
  );
});

test("external MCP acquisition requires high-risk allowance and explicit per-Mission approval", async () => {
  const catalog = new ExternalMcpCatalog(entries);
  const candidate = catalog.discover(need())[0]!.candidate;
  const receipts = new MemoryReceipts();
  const registry = new MissionExternalMcpRegistry();
  let approvalCalls = 0;
  const acquirer = new ExternalMcpAcquirer({
    catalog,
    receipts,
    registry,
    approvals: {
      async requestApproval(request) {
        approvalCalls += 1;
        assert.equal(request.missionId, "mission-external-mcp");
        assert.equal((request.details as any).credentials, "none");
        assert.equal(JSON.stringify(request.details).includes("secret"), false);
        return { approved: true, actor: "user" };
      }
    }
  });

  await assert.rejects(() => acquirer.acquire(candidate, need("medium")), /risk high exceeds need maxRisk medium/);
  assert.equal(approvalCalls, 0, "risk policy must reject before asking for approval");
  assert.equal(receipts.receipts.at(-1)?.status, "rejected");

  const acquired = await acquirer.acquire(candidate, need("high"));
  assert.equal(approvalCalls, 1);
  assert.equal(acquired.capability.id, "external-mcp:vendor-docs");
  assert.equal(acquired.capability.kind, "mcp");
  assert.equal(acquired.capability.invocationRef, "https://mcp.example.test/mcp");
  assert.equal(acquired.capability.native?.provider, "external-mcp");
  assert(acquired.capability.native?.features?.includes("no-credentials"));
  assert.equal(acquired.receipt.status, "activated");
  assert.equal("smoke" in acquired.receipt, false, "Runtime must not invent a remote MCP smoke result it did not execute");
  assert.deepEqual(registry.select(need().missionId, [acquired.capability.id]), [{
    transport: "http",
    name: "vendor_docs",
    url: "https://mcp.example.test/mcp",
    headers: []
  }]);
});

test("external MCP capability runtime restores mission delivery state from durable capability descriptors", async () => {
  const catalog = new ExternalMcpCatalog(entries);
  const registry = new MissionExternalMcpRegistry();
  const base = new MissingRuntime();
  const receipts = new MemoryReceipts();
  const acquirer = new ExternalMcpAcquirer({
    catalog,
    receipts,
    registry,
    approvals: { async requestApproval() { return { approved: true, actor: "user" }; } }
  });
  const runtime = new ExternalMcpCapabilityRuntime({ base, catalog, acquirer, registry });
  const result = await runtime.ensure(need());
  assert.equal(result.status, "resolved");
  assert.equal(result.source, "acquired");
  assert(result.capability);

  const restartedRegistry = new MissionExternalMcpRegistry();
  const restartedBase = new MissingRuntime();
  const restarted = new ExternalMcpCapabilityRuntime({
    base: restartedBase,
    catalog,
    acquirer: new ExternalMcpAcquirer({
      catalog,
      receipts: new MemoryReceipts(),
      registry: restartedRegistry,
      approvals: { async requestApproval() { return { approved: false }; } }
    }),
    registry: restartedRegistry
  });
  restarted.restoreMissionCapabilities(need().missionId, [result.capability!]);
  assert.deepEqual(restartedRegistry.select(need().missionId, [result.capability!.id]), [{
    transport: "http",
    name: "vendor_docs",
    url: "https://mcp.example.test/mcp",
    headers: []
  }]);

  restarted.deactivateMissionCapability(need().missionId, result.capability!.id);
  assert.throws(
    () => restartedRegistry.select(need().missionId, [result.capability!.id]),
    /not activated for Mission/
  );
});
