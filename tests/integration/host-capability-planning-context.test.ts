import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekHarnessAdapter } from "../../src/hosts/deepseek/deepseek-host-adapter.ts";
import { HostDeliberationProvider } from "../../src/runtime/host-deliberation-provider.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

class CapturingTransport implements HostJsonTransport {
  readonly requests: HostJsonRequest[] = [];
  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return { graphRevision: 2, capabilityNeeds: [], workItems: [] };
  }
}

test("DeepSeek adapter publishes ACP native semantics through capabilityGraph", async () => {
  const bindings = {
    async describe() { return { type: "deepseek-harness", version: "test" }; },
    async environment() {
      return {
        revision: 5,
        host: { type: "deepseek-harness", version: "test" },
        capabilities: [{
          id: "deepseek-harness.acp-agent",
          kind: "agent" as const,
          name: "DeepSeek Harness ACP Agent",
          description: "ACP agent",
          hostNative: true,
          available: true,
          invocationRef: "dsh --profile acp",
          permissions: ["host-agent-session"],
          scope: "host" as const
        }],
        shellAvailable: false,
        filesystemAvailable: false,
        browserAvailable: false,
        capturedAt: new Date().toISOString()
      };
    }
  } as any;

  const snapshot = await new DeepSeekHarnessAdapter(bindings).snapshotEnvironment();
  const acp = snapshot.capabilities.find(capability => capability.id === "deepseek-harness.acp-agent");
  assert.equal(acp?.native?.protocol, "acp-v1");
  assert.equal(acp?.routing?.executionMode, "host-agent");
  assert.equal(acp?.routing?.resumable, true);
  assert.ok(acp?.functions?.includes("resume agent session"));
  assert.ok(snapshot.capabilityGraph);
  assert.equal(snapshot.capabilityGraph?.revision, 5);
  const node = snapshot.capabilityGraph?.nodes.find(candidate => candidate.kind === "capability" && candidate.capability.id === "deepseek-harness.acp-agent");
  assert.equal(node?.kind, "capability");
  if (node?.kind === "capability") {
    assert.equal(node.capability.native?.provider, "deepseek-harness");
    assert.deepEqual(node.capability.native?.persistence, ["session", "resume", "recovery"]);
  }
});

test("frontier planner receives one graph combining live host and mission-local capabilities", async () => {
  const transport = new CapturingTransport();
  let eventReplayCalls = 0;
  const events = {
    async list() { eventReplayCalls += 1; throw new Error("planner should use durable reader"); }
  } as any;
  const reader = {
    async journal() {
      return {
        userGoal: "produce and verify a web artifact",
        capabilityNeeds: new Map(),
        capabilities: new Map([
          ["mission-skill", {
            id: "mission-skill",
            kind: "skill" as const,
            name: "Mission Skill",
            description: "mission-local semantic helper",
            hostNative: false,
            available: true,
            permissions: [],
            scope: "mission" as const,
            functions: ["analyze web content"],
            routing: { executionMode: "mission-context" as const, isolation: "instruction-only" as const },
            provenance: { source: "mission" as const, revision: "abc123" }
          }]
        ]),
        workItems: new Map(),
        artifacts: new Map(),
        gaps: new Map()
      };
    },
    async latestStrategy() { return undefined; }
  } as any;
  const host = {
    async snapshotEnvironment() {
      return {
        revision: 11,
        host: { type: "planner-host", version: "1" },
        capabilities: [{
          id: "browser-renderer",
          kind: "tool" as const,
          name: "Browser Renderer",
          description: "render web page",
          hostNative: true,
          available: true,
          permissions: ["browser"],
          scope: "host" as const,
          functions: ["render web page"],
          accepts: ["html"],
          produces: ["screenshot"],
          constraints: { requiredEnvironment: ["browser" as const] },
          routing: { executionMode: "host-capability" as const, executorIds: ["host-default"] }
        }],
        shellAvailable: false,
        filesystemAvailable: true,
        browserAvailable: true,
        capturedAt: new Date().toISOString()
      };
    }
  } as any;
  const provider = new HostDeliberationProvider({
    transport,
    events,
    reader,
    host,
    knownExecutorIds: ["host-default"],
    defaultExecutorId: "host-default"
  });
  const state = {
    missionId: "mission-planner-graph",
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

  const proposal = await provider.planFrontier({ state, openGaps: [] });
  assert.equal(proposal.graphRevision, 2);
  assert.equal(eventReplayCalls, 0);
  assert.equal(transport.requests.length, 1);
  const request = transport.requests[0];
  assert.match(request.instruction, /hostCapabilityGraph as the source of truth/);
  const graph = (request.input as any).hostCapabilityGraph;
  assert.equal(graph.revision, 11);
  assert.equal(graph.host.type, "planner-host");
  const capabilityIds = graph.nodes
    .filter((node: any) => node.kind === "capability")
    .map((node: any) => node.capability.id)
    .sort();
  assert.deepEqual(capabilityIds, ["browser-renderer", "mission-skill"]);
  assert.ok(graph.nodes.some((node: any) => node.kind === "environment" && node.environment === "browser" && node.available === true));
  assert.ok(graph.edges.some((edge: any) => edge.relation === "routes-via" && edge.to === "route:host-default"));
});
