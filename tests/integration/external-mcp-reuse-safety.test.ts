import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed, RiskLevel } from "../../src/core/domain/capability.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import type {
  IdempotentAcquisitionApprovalBroker,
  IdempotentAcquisitionApprovalRequest
} from "../../src/runtime/approval-manager.ts";
import { ExternalMcpAdmissionRuntime } from "../../src/runtime/external-mcp-admission.ts";
import { ExternalMcpCatalogDiscoveryProvider } from "../../src/runtime/external-mcp-catalog.ts";

class ReusingRuntime implements CapabilityRuntime {
  private readonly capability: CapabilityDescriptor;

  constructor(capability: CapabilityDescriptor) {
    this.capability = capability;
  }

  restoreMissionCapabilities(): void {}
  deactivateMissionCapability(): void {}
  async ensure(): Promise<CapabilityEnsureResult> {
    return {
      status: "resolved",
      capability: this.capability,
      source: "host-or-overlay",
      attempts: [],
      reason: "resolved from Mission overlay"
    };
  }
}

class ApprovingBroker implements IdempotentAcquisitionApprovalBroker {
  readonly requests: IdempotentAcquisitionApprovalRequest[] = [];
  async requestApproval(request: IdempotentAcquisitionApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    this.requests.push(structuredClone(request));
    return { approved: true, actor: "user:test" };
  }
}

function externalCapability(id = "old-docs", name = "old_docs"): CapabilityDescriptor {
  return {
    id: `external-mcp:${id}`,
    kind: "mcp",
    name,
    description: "External vendor documentation MCP",
    hostNative: false,
    available: true,
    invocationRef: `https://${id}.example.test/mcp`,
    permissions: ["network-read", "external-mcp-tools"],
    revision: "2026-10-31.r1",
    scope: "mission",
    functions: ["search vendor docs"],
    accepts: ["query"],
    produces: ["documentation"],
    constraints: { supportedPurposes: ["research"] },
    routing: { executionMode: "host-agent", isolation: "remote" },
    cost: { monetaryClass: "unknown", latencyClass: "remote", metered: true },
    native: {
      provider: "external-mcp",
      nativeId: name,
      protocol: "mcp-streamable-http",
      loadMode: "mission-overlay",
      approvalModes: ["once"],
      features: ["remote-https", "no-credentials", "explicit-acquisition-approval", "provider-native-mcp-config"],
      persistence: ["session", "resume", "recovery", "durable-state"]
    },
    provenance: {
      source: "external",
      sourceRef: `mcp-registry:${id}@2026-10-31.r1`,
      revision: "2026-10-31.r1",
      contentHash: `sha256:${"a".repeat(64)}`
    }
  };
}

function need(maxRisk: RiskLevel): CapabilityNeed {
  return {
    id: "need-external-docs-reuse",
    missionId: "mission-external-mcp-reuse",
    objective: "search vendor docs",
    requiredFunctions: ["search vendor docs"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk,
    policy: {
      acceptableKinds: ["mcp"],
      requiredExecutionModes: ["host-agent"],
      acceptableProviders: ["external-mcp"],
      requiredNativeFeatures: ["no-credentials"],
      acceptableProvenanceSources: ["external"]
    },
    requirementRefs: [],
    gapRefs: []
  };
}

function runtime(input: {
  active: CapabilityDescriptor;
  approvals: ApprovingBroker;
  revoked?: (capabilityId: string) => boolean;
  catalog?: ConstructorParameters<typeof ExternalMcpCatalogDiscoveryProvider>[0];
}): ExternalMcpAdmissionRuntime {
  return new ExternalMcpAdmissionRuntime({
    base: new ReusingRuntime(input.active),
    catalog: new ExternalMcpCatalogDiscoveryProvider(input.catalog ?? []),
    approvals: input.approvals,
    revocations: {
      isCapabilityRevoked: (_missionId, capabilityId) => input.revoked?.(capabilityId) ?? false
    }
  });
}

test("active external MCP reuse still respects the current CapabilityNeed maxRisk gate", async () => {
  const approvals = new ApprovingBroker();
  const result = await runtime({ active: externalCapability(), approvals }).ensure(need("medium"));

  assert.notEqual(result.status, "resolved");
  assert.match(result.reason, /high-risk|allows medium/i);
  assert.equal(approvals.requests.length, 0);
});

test("durably revoked active external MCP cannot escape through the base resolved fast path", async () => {
  const approvals = new ApprovingBroker();
  const result = await runtime({
    active: externalCapability(),
    approvals,
    revoked: capabilityId => capabilityId === "external-mcp:old-docs",
    catalog: [{
      id: "new-docs",
      name: "new_docs",
      description: "Replacement external vendor documentation MCP",
      revision: "2026-10-31.r2",
      url: "https://new-docs.example.test/mcp",
      functions: ["search vendor docs"],
      accepts: ["query"],
      produces: ["documentation"]
    }]
  }).ensure(need("high"));

  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "external-mcp:new-docs");
  assert.equal(approvals.requests.length, 1);
});

test("eligible non-revoked active external MCP is reused without a second approval", async () => {
  const approvals = new ApprovingBroker();
  const active = externalCapability();
  const result = await runtime({ active, approvals }).ensure(need("high"));

  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, active.id);
  assert.equal(approvals.requests.length, 0);
});
