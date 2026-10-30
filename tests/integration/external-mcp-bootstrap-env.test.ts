import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { createProductionMissionRuntimeFromEnv } from "../../src/runtime/bootstrap.ts";

const VALID_CATALOG = [{
  id: "vendor-docs",
  name: "vendor_docs",
  description: "External vendor documentation MCP",
  revision: "2026-10-31.r1",
  url: "https://mcp.example.test/mcp",
  functions: ["search vendor docs"],
  accepts: ["query"],
  produces: ["documentation"]
}];

test("production env validates external MCP catalog JSON before Runtime startup", async () => {
  const root = await mkdtemp(`${tmpdir()}/mission-external-mcp-env-invalid-`);
  let runtime: ReturnType<typeof createProductionMissionRuntimeFromEnv> | undefined;
  try {
    assert.throws(() => {
      runtime = createProductionMissionRuntimeFromEnv({
        MISSION_HOME: root,
        MISSION_HOST_KIND: "codex",
        MISSION_CODEX_NATIVE_DISCOVERY: "0",
        MISSION_EXTERNAL_MCP_CATALOG_JSON: JSON.stringify({ not: "an array" })
      }, process.cwd());
    }, /External MCP catalog must be a JSON array/);
  } finally {
    runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("production external MCP config preserves the trusted direct-injection boundary", async () => {
  const root = await mkdtemp(`${tmpdir()}/mission-external-mcp-env-valid-`);
  const runtime = createProductionMissionRuntimeFromEnv({
    MISSION_HOME: root,
    MISSION_HOST_KIND: "codex",
    MISSION_CODEX_NATIVE_DISCOVERY: "0",
    MISSION_EXTERNAL_MCP_CATALOG_JSON: JSON.stringify(VALID_CATALOG)
  }, process.cwd());
  try {
    await assert.rejects(
      () => runtime.host.createAgent({
        missionId: "mission-external-mcp-env",
        workItemId: "direct-injection",
        context: {},
        allowedCapabilityRefs: [],
        mcpServers: [{
          transport: "http",
          name: "bypass",
          url: "https://bypass.example.test/mcp",
          headers: []
        }]
      }),
      /reserved for TrustedMcpHostAdapter delivery/
    );
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});
