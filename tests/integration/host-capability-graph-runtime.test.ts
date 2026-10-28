import test from "node:test";
import assert from "node:assert/strict";
import type { CapabilityNeed } from "../../src/core/domain/capability.ts";
import { HostCapabilityRuntime } from "../../src/runtime/host-capability-runtime.ts";

function need(): CapabilityNeed {
  return {
    id: "need-browser-render",
    missionId: "mission-capability-graph",
    objective: "verify a rendered web experience",
    requiredFunctions: ["render web page"],
    desiredInputs: ["html"],
    desiredOutputs: ["screenshot"],
    purpose: "verification",
    urgency: "blocking",
    acquisitionAllowed: false,
    maxRisk: "medium",
    requirementRefs: [],
    gapRefs: []
  };
}

test("HostCapabilityRuntime rejects a matching host capability when its browser dependency is unavailable", async () => {
  const host = {
    async snapshotEnvironment() {
      return {
        revision: 9,
        host: { type: "graph-host", version: "1" },
        capabilities: [{
          id: "browser-renderer",
          kind: "tool" as const,
          name: "Browser Renderer",
          description: "render web page",
          hostNative: true,
          available: true,
          permissions: [],
          scope: "host" as const,
          functions: ["render web page"],
          accepts: ["html"],
          produces: ["screenshot"],
          constraints: { requiredEnvironment: ["browser" as const], supportedPurposes: ["verification" as const] },
          routing: { executionMode: "host-capability" as const }
        }],
        shellAvailable: true,
        filesystemAvailable: true,
        browserAvailable: false,
        capturedAt: new Date().toISOString()
      };
    }
  } as any;

  const result = await new HostCapabilityRuntime(host).ensure(need());
  assert.equal(result.status, "missing");
  assert.match(result.reason, /required environment browser is unavailable/);
});

test("HostCapabilityRuntime selects an environment-compatible semantic capability and preserves routing metadata", async () => {
  const host = {
    async snapshotEnvironment() {
      return {
        revision: 10,
        host: { type: "graph-host", version: "1" },
        capabilities: [
          {
            id: "generic-text-tool",
            kind: "tool" as const,
            name: "Render Web Page",
            description: "render web page screenshot html",
            hostNative: true,
            available: true,
            permissions: ["shell"],
            scope: "host" as const
          },
          {
            id: "browser-renderer",
            kind: "tool" as const,
            name: "Browser Renderer",
            description: "browser-backed rendering",
            hostNative: true,
            available: true,
            permissions: ["browser"],
            scope: "host" as const,
            functions: ["render web page"],
            accepts: ["html"],
            produces: ["screenshot"],
            constraints: { requiredEnvironment: ["browser" as const], supportedPurposes: ["verification" as const] },
            routing: {
              executionMode: "host-capability" as const,
              executorIds: ["browser-worker"],
              isolation: "remote" as const
            },
            cost: { monetaryClass: "low" as const, latencyClass: "interactive" as const }
          }
        ],
        shellAvailable: true,
        filesystemAvailable: true,
        browserAvailable: true,
        capturedAt: new Date().toISOString()
      };
    }
  } as any;

  const result = await new HostCapabilityRuntime(host).ensure(need());
  assert.equal(result.status, "resolved");
  assert.equal(result.capability?.id, "browser-renderer");
  assert.deepEqual(result.capability?.routing?.executorIds, ["browser-worker"]);
  assert.match(result.reason, /capability graph/);
});
