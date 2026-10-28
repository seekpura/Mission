import test from "node:test";
import assert from "node:assert/strict";
import { buildHostCapabilityGraph } from "../../src/core/capabilities/capability-graph.ts";
import { CapabilityWorkspaceHostAdapter } from "../../src/runtime/capability-context-host-adapter.ts";
import { TrustedMcpHostAdapter, TrustedMcpRegistry } from "../../src/runtime/trusted-mcp-runtime.ts";

test("outer capability delivery boundary rebuilds graph after trusted MCP extends host catalog", async () => {
  const base = {
    async describeHost() { return { type: "wrapped-host", version: "1" }; },
    async snapshotEnvironment() {
      const capabilities = [{
        id: "host-agent",
        kind: "agent" as const,
        name: "Host Agent",
        description: "host agent",
        hostNative: true,
        available: true,
        permissions: [],
        scope: "host" as const,
        functions: ["execute mission work"]
      }];
      return {
        revision: 3,
        host: { type: "wrapped-host", version: "1" },
        capabilities,
        capabilityGraph: buildHostCapabilityGraph({
          revision: 3,
          host: { type: "wrapped-host", version: "1" },
          capabilities,
          shellAvailable: false,
          filesystemAvailable: true,
          browserAvailable: false
        }),
        shellAvailable: false,
        filesystemAvailable: true,
        browserAvailable: false,
        capturedAt: new Date().toISOString()
      };
    }
  } as any;
  const registry = new TrustedMcpRegistry([{
    id: "trusted-mcp:docs",
    name: "docs",
    description: "search trusted documentation",
    revision: "rev-1",
    transport: "http",
    url: "https://mcp.example.test/"
  }]);
  const mcp = new TrustedMcpHostAdapter(base, registry);
  const skills = { project() {} } as any;
  const outer = new CapabilityWorkspaceHostAdapter(mcp, skills);

  const snapshot = await outer.snapshotEnvironment();
  assert.deepEqual(
    snapshot.capabilities.map(capability => capability.id).sort(),
    ["host-agent", "trusted-mcp:docs"]
  );
  const graphCapabilityIds = snapshot.capabilityGraph?.nodes
    .filter(node => node.kind === "capability")
    .map(node => node.kind === "capability" ? node.capability.id : "")
    .sort();
  assert.deepEqual(graphCapabilityIds, ["host-agent", "trusted-mcp:docs"]);
});
