import assert from "node:assert/strict";
import test from "node:test";
import type { EventStore } from "../../src/core/events/event-store.ts";
import { initialMissionState } from "../../src/core/events/state-projector.ts";
import type { MissionReadModelReader } from "../../src/core/mission/mission-reader.ts";
import type { MissionJournalView } from "../../src/core/mission/journal-view.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";
import { HostDeliberationProvider } from "../../src/runtime/host-deliberation-provider.ts";

class FrontierTransport implements HostJsonTransport {
  private readonly frontier: unknown;
  lastRequest?: HostJsonRequest;

  constructor(frontier: unknown) {
    this.frontier = frontier;
  }

  async request(input: HostJsonRequest): Promise<unknown> {
    this.lastRequest = input;
    return this.frontier;
  }
}

function reader(): MissionReadModelReader {
  const journal: MissionJournalView = {
    missionId: "mission-planner-constraints",
    userGoal: "Use a trusted research MCP to gather current sources",
    workItems: new Map(),
    artifacts: new Map(),
    capabilityNeeds: new Map(),
    capabilities: new Map(),
    gaps: new Map(),
    decisionIds: new Set()
  };
  return {
    async state() { return state(); },
    async journal() { return journal; },
    async latestStrategy() { return undefined; }
  };
}

function eventStore(): EventStore {
  return {
    async append() { throw new Error("not used"); },
    async list() { return []; },
    async lastSequence() { return 0; }
  };
}

function state() {
  const value = initialMissionState("mission-planner-constraints");
  value.status = "active";
  value.revision = 3;
  value.graphRevision = 0;
  return value;
}

function frontier(acceptableKinds: string[] = ["mcp"]) {
  return {
    graphRevision: 1,
    capabilityNeeds: [{
      id: "need-research-mcp",
      objective: "Retrieve current cited sources through a trusted provider-native MCP",
      requiredFunctions: ["web research source retrieval"],
      desiredInputs: ["research query"],
      desiredOutputs: ["source records"],
      purpose: "research",
      urgency: "blocking",
      acquisitionAllowed: false,
      maxRisk: "low",
      acceptableKinds,
      requiredDeliveryModes: ["acp-mcp-http"],
      forbiddenPermissions: ["mcp-stdio-process"],
      acceptableTrust: ["operator-trusted"],
      maxCostClass: "low",
      requirementRefs: ["req-research"],
      gapRefs: []
    }],
    workItems: [{
      id: "work-research",
      purpose: "production",
      objective: "Gather current source evidence",
      requirementRefs: ["req-research"],
      gapRefs: [],
      inputArtifactRefs: [],
      expectedOutputs: [{ logicalName: "sources", type: "research", required: true }],
      localAcceptanceCriteria: [],
      capabilityNeedRefs: ["need-research-mcp"],
      priority: 10
    }]
  };
}

test("HostDeliberationProvider preserves validated capability graph constraints", async () => {
  const transport = new FrontierTransport(frontier());
  const provider = new HostDeliberationProvider({
    transport,
    events: eventStore(),
    reader: reader(),
    knownExecutorIds: ["deepseek-host"],
    defaultExecutorId: "deepseek-host"
  });

  const proposal = await provider.planFrontier({ state: state(), openGaps: [] });
  const need = proposal.capabilityNeeds?.[0];
  assert.ok(need);
  assert.deepEqual(need.acceptableKinds, ["mcp"]);
  assert.deepEqual(need.requiredDeliveryModes, ["acp-mcp-http"]);
  assert.deepEqual(need.forbiddenPermissions, ["mcp-stdio-process"]);
  assert.deepEqual(need.acceptableTrust, ["operator-trusted"]);
  assert.equal(need.maxCostClass, "low");
  assert.equal(proposal.workItems[0]?.assignedExecutorId, "deepseek-host");
  assert.match(transport.lastRequest?.instruction ?? "", /acceptableKinds/);
});

test("HostDeliberationProvider rejects unknown capability constraint enum values", async () => {
  const provider = new HostDeliberationProvider({
    transport: new FrontierTransport(frontier(["imaginary-provider-kind"])),
    events: eventStore(),
    reader: reader(),
    knownExecutorIds: ["deepseek-host"],
    defaultExecutorId: "deepseek-host"
  });

  await assert.rejects(
    provider.planFrontier({ state: state(), openGaps: [] }),
    /Unsupported value at frontier\.capabilityNeeds\[0\]\.acceptableKinds\[0\]/
  );
});
