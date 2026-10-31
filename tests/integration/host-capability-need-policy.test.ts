import assert from "node:assert/strict";
import test from "node:test";
import { HostDeliberationProvider } from "../../src/runtime/host-deliberation-provider.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

const missionId = "mission-capability-policy";

class FrontierTransport implements HostJsonTransport {
  readonly requests: HostJsonRequest[] = [];
  private readonly capabilityNeed: Record<string, unknown>;

  constructor(capabilityNeed: Record<string, unknown>) {
    this.capabilityNeed = capabilityNeed;
  }

  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return {
      graphRevision: 2,
      capabilityNeeds: [this.capabilityNeed],
      workItems: []
    };
  }
}

function state() {
  return {
    missionId,
    status: "active",
    revision: 4,
    missionSpecRevision: 1,
    acceptanceRevision: 1,
    strategyRevision: 1,
    graphRevision: 1,
    readyWorkItemIds: [],
    activeWorkItemIds: [],
    blockedWorkItemIds: [],
    verifyingWorkItemIds: [],
    openGapIds: [],
    blockingGapIds: [],
    activeExecutionIds: [],
    pendingApprovalIds: [],
    finalArtifactRefs: []
  } as any;
}

function need(policy: unknown): Record<string, unknown> {
  return {
    id: "need-external-docs",
    objective: "search vendor documentation through an approved remote MCP",
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

function provider(capabilityNeed: Record<string, unknown>) {
  const transport = new FrontierTransport(capabilityNeed);
  const events = {
    async list() { throw new Error("planner policy test must use durable reader"); }
  } as any;
  const reader = {
    async journal() {
      return {
        userGoal: "research vendor documentation",
        capabilityNeeds: new Map(),
        capabilities: new Map(),
        workItems: new Map(),
        artifacts: new Map(),
        gaps: new Map()
      };
    },
    async latestStrategy() { return undefined; }
  } as any;
  return new HostDeliberationProvider({
    transport,
    events,
    reader,
    knownExecutorIds: ["host-default"],
    defaultExecutorId: "host-default"
  });
}

test("frontier planner preserves every supported CapabilityNeed policy hard gate", async () => {
  const policy = {
    acceptableKinds: ["mcp", "tool"],
    requiredExecutionModes: ["remote-service", "host-capability"],
    forbiddenPermissions: ["filesystem-write", "host-process"],
    acceptableProviders: ["external-mcp", "trusted-provider"],
    requiredNativeFeatures: ["no-credentials", "read-only"],
    acceptableProvenanceSources: ["external", "host"],
    maxMonetaryClass: "medium"
  };

  const proposal = await provider(need(policy)).planFrontier({ state: state(), openGaps: [] });
  const capabilityNeeds = proposal.capabilityNeeds ?? [];
  assert.equal(capabilityNeeds.length, 1);
  assert.deepEqual(capabilityNeeds[0]?.policy, policy);
});

test("frontier planner fails closed on malformed CapabilityNeed policy instead of dropping it", async () => {
  const invalidPolicies: unknown[] = [
    { acceptableKinds: ["mcp", "not-a-kind"] },
    { requiredExecutionModes: ["remote-service", "magic"] },
    { forbiddenPermissions: [""] },
    { acceptableProviders: ["external-mcp", ""] },
    { requiredNativeFeatures: ["no-credentials", 42] },
    { acceptableProvenanceSources: ["external", "internet"] },
    { maxMonetaryClass: "unknown" },
    { acceptableKinds: ["mcp"], typoKinds: ["tool"] }
  ];

  for (const policy of invalidPolicies) {
    await assert.rejects(
      () => provider(need(policy)).planFrontier({ state: state(), openGaps: [] }),
      /policy|capability need/i,
      `malformed policy should fail closed: ${JSON.stringify(policy)}`
    );
  }
});
