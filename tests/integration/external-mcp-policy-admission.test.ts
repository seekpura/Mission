import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed, CapabilityNeedPolicy } from "../../src/core/domain/capability.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import {
  type IdempotentAcquisitionApprovalBroker,
  type IdempotentAcquisitionApprovalRequest
} from "../../src/runtime/approval-manager.ts";
import { ExternalMcpAdmissionRuntime } from "../../src/runtime/external-mcp-admission.ts";
import { ExternalMcpCatalogDiscoveryProvider } from "../../src/runtime/external-mcp-catalog.ts";

class MissingRuntime implements CapabilityRuntime {
  restoreMissionCapabilities(_missionId: string, _capabilities: Iterable<CapabilityDescriptor>): void {}
  deactivateMissionCapability(_missionId: string, _capabilityId: string): void {}
  async ensure(): Promise<CapabilityEnsureResult> {
    return { status: "missing", source: "none", attempts: [], reason: "no existing capability" };
  }
}

class ApprovingBroker implements IdempotentAcquisitionApprovalBroker {
  readonly requests: IdempotentAcquisitionApprovalRequest[] = [];

  async requestApproval(request: IdempotentAcquisitionApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    this.requests.push(structuredClone(request));
    return { approved: true, actor: "user:test" };
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

function need(policy: CapabilityNeedPolicy): CapabilityNeed {
  return {
    id: "need-external-docs",
    missionId: "mission-external-mcp-policy",
    objective: "search vendor docs",
    requiredFunctions: ["search vendor docs"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "high",
    policy,
    requirementRefs: [],
    gapRefs: []
  };
}

function runtime(approvals: ApprovingBroker): ExternalMcpAdmissionRuntime {
  return new ExternalMcpAdmissionRuntime({
    base: new MissingRuntime(),
    catalog,
    approvals,
    revocations: { isCapabilityRevoked: () => false }
  });
}

test("external MCP admission applies every CapabilityNeed policy hard gate before approval", async () => {
  const blockedPolicies: Array<{ label: string; policy: CapabilityNeedPolicy; reason: RegExp }> = [
    {
      label: "execution mode",
      policy: { acceptableKinds: ["mcp"], requiredExecutionModes: ["remote-service"] },
      reason: /execution mode/i
    },
    {
      label: "forbidden permission",
      policy: { acceptableKinds: ["mcp"], forbiddenPermissions: ["network-read"] },
      reason: /forbidden permissions/i
    },
    {
      label: "provider",
      policy: { acceptableKinds: ["mcp"], acceptableProviders: ["trusted-mcp"] },
      reason: /provider/i
    },
    {
      label: "native feature",
      policy: { acceptableKinds: ["mcp"], requiredNativeFeatures: ["citations"] },
      reason: /native features/i
    },
    {
      label: "provenance",
      policy: { acceptableKinds: ["mcp"], acceptableProvenanceSources: ["host"] },
      reason: /provenance/i
    },
    {
      label: "monetary class",
      policy: { acceptableKinds: ["mcp"], maxMonetaryClass: "high" },
      reason: /monetary cost/i
    }
  ];

  for (const { label, policy, reason } of blockedPolicies) {
    const approvals = new ApprovingBroker();
    const result = await runtime(approvals).ensure(need(policy));
    assert.equal(result.status, "acquisition_failed", `${label} mismatch must fail acquisition`);
    assert.equal(approvals.requests.length, 0, `${label} mismatch must fail before approval`);
    assert.match(result.reason, reason, `${label} mismatch should explain the violated hard gate`);
  }
});

test("external MCP admission still requests approval when the complete policy is satisfied", async () => {
  const approvals = new ApprovingBroker();
  const result = await runtime(approvals).ensure(need({
    acceptableKinds: ["mcp"],
    requiredExecutionModes: ["host-agent"],
    forbiddenPermissions: ["filesystem-write"],
    acceptableProviders: ["external-mcp"],
    requiredNativeFeatures: ["no-credentials", "remote-https"],
    acceptableProvenanceSources: ["external"]
  }));

  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "external-mcp:vendor-docs");
  assert.equal(approvals.requests.length, 1);
});
