import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import {
  buildHostCapabilityGraph,
  capabilityNodeId,
  environmentNodeId,
  routeNodeId
} from "../../src/core/capabilities/capability-graph.ts";
import { CapabilityResolver } from "../../src/core/capabilities/resolver.ts";

function need(overrides: Partial<CapabilityNeed> = {}): CapabilityNeed {
  return {
    id: "need-1",
    missionId: "mission-1",
    objective: "render and inspect a web page",
    requiredFunctions: ["render web page"],
    desiredInputs: ["html"],
    desiredOutputs: ["screenshot"],
    purpose: "verification",
    urgency: "blocking",
    acquisitionAllowed: false,
    maxRisk: "medium",
    requirementRefs: [],
    gapRefs: [],
    ...overrides
  };
}

function capability(id: string, overrides: Partial<CapabilityDescriptor> = {}): CapabilityDescriptor {
  return {
    id,
    kind: "tool",
    name: id,
    description: id,
    hostNative: true,
    available: true,
    permissions: [],
    scope: "host",
    ...overrides
  };
}

test("capability graph materializes dependency, environment and route edges", () => {
  const graph = buildHostCapabilityGraph({
    revision: 4,
    host: { type: "test-host", version: "1" },
    shellAvailable: true,
    filesystemAvailable: true,
    browserAvailable: false,
    capabilities: [
      capability("browser-render", {
        functions: ["render web page"],
        constraints: {
          requiredEnvironment: ["browser"],
          requiresCapabilityRefs: ["html-parser"],
          supportedPurposes: ["verification"]
        },
        routing: {
          executionMode: "host-capability",
          executorIds: ["browser-worker"],
          resumable: false
        }
      }),
      capability("html-parser", { functions: ["parse html"] })
    ]
  });

  assert.equal(graph.revision, 4);
  assert.ok(graph.nodes.some(node => node.id === capabilityNodeId("browser-render")));
  assert.ok(graph.nodes.some(node => node.id === environmentNodeId("browser") && node.kind === "environment" && node.available === false));
  assert.ok(graph.nodes.some(node => node.id === routeNodeId("browser-worker") && node.kind === "route"));
  assert.ok(graph.edges.some(edge => edge.from === capabilityNodeId("browser-render") && edge.to === capabilityNodeId("html-parser") && edge.relation === "requires"));
  assert.ok(graph.edges.some(edge => edge.from === capabilityNodeId("browser-render") && edge.to === environmentNodeId("browser") && edge.relation === "requires-environment"));
  assert.ok(graph.edges.some(edge => edge.from === capabilityNodeId("browser-render") && edge.to === routeNodeId("browser-worker") && edge.relation === "routes-via"));
});

test("resolver rejects a semantically matching capability when required host environment is unavailable", () => {
  const graph = buildHostCapabilityGraph({
    revision: 7,
    host: { type: "test-host" },
    browserAvailable: false,
    capabilities: [
      capability("needs-browser", {
        functions: ["render web page"],
        accepts: ["html"],
        produces: ["screenshot"],
        constraints: { requiredEnvironment: ["browser"], supportedPurposes: ["verification"] }
      })
    ]
  });

  const result = new CapabilityResolver().resolve(need(), graph);
  assert.equal(result.status, "missing");
  assert.match(result.reason, /required environment browser is unavailable/);
  assert.equal(result.graphRevision, 7);
});

test("resolver requires declared capability dependencies to be available", () => {
  const graph = buildHostCapabilityGraph({
    revision: 2,
    host: { type: "test-host" },
    browserAvailable: true,
    capabilities: [
      capability("render", {
        functions: ["render web page"],
        accepts: ["html"],
        produces: ["screenshot"],
        constraints: { requiresCapabilityRefs: ["missing-engine"] }
      })
    ]
  });

  const result = new CapabilityResolver().resolve(need(), graph);
  assert.equal(result.status, "missing");
  assert.match(result.reason, /required capability missing-engine is unavailable/);
});

test("resolver prefers explicit semantic functions and compatible I/O over free-text coincidence", () => {
  const graph = buildHostCapabilityGraph({
    revision: 3,
    host: { type: "test-host" },
    browserAvailable: true,
    capabilities: [
      capability("text-coincidence", {
        name: "Render Web Page Screenshot Utility",
        description: "render web page screenshot html",
        permissions: ["broad-network", "filesystem-write", "shell"],
        cost: { monetaryClass: "high" }
      }),
      capability("semantic-renderer", {
        name: "Browser Renderer",
        description: "headless browser service",
        functions: ["render web page", "capture viewport"],
        accepts: ["html", "url"],
        produces: ["screenshot", "dom snapshot"],
        constraints: { requiredEnvironment: ["browser"], supportedPurposes: ["verification"] },
        routing: { executionMode: "host-capability", executorIds: ["browser-route"] },
        cost: { monetaryClass: "low" }
      })
    ]
  });

  const result = new CapabilityResolver().resolve(need(), graph);
  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "semantic-renderer");
  assert.deepEqual(result.rankedMatches?.[0].routeExecutorIds, ["browser-route"]);
  assert.match(result.reason, /explicit semantic functions matched/);
});

test("flat legacy capability arrays still resolve when no graph constraints are declared", () => {
  const result = new CapabilityResolver().resolve(
    need({ requiredFunctions: ["technical animation"], desiredInputs: [], desiredOutputs: [], purpose: "production" }),
    [capability("motion", { name: "Technical Animation", description: "render technical animation diagrams" })]
  );
  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "motion");
});
