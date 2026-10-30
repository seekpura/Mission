import assert from "node:assert/strict";
import test from "node:test";
import type { CapabilityCandidate, CapabilityNeed } from "../../src/core/domain/capability.ts";

interface ExternalMcpCatalogEntry {
  id: string;
  name: string;
  description: string;
  revision: string;
  url: string;
  functions: string[];
  accepts?: string[];
  produces?: string[];
}

interface ExternalMcpCatalogModule {
  parseExternalMcpCatalogJson(value: string | undefined): ExternalMcpCatalogEntry[];
  ExternalMcpCatalogDiscoveryProvider: new (entries: ExternalMcpCatalogEntry[]) => {
    id: string;
    discover(need: CapabilityNeed): Promise<CapabilityCandidate[]>;
  };
}

async function loadModule(): Promise<ExternalMcpCatalogModule> {
  const moduleUrl = new URL("../../src/runtime/external-mcp-catalog.ts", import.meta.url);
  return await import(moduleUrl.href) as ExternalMcpCatalogModule;
}

function need(policyKinds?: CapabilityNeed["policy"] extends infer P ? P extends { acceptableKinds?: infer K } ? K : never : never): CapabilityNeed {
  return {
    id: "need-external-mcp",
    missionId: "mission-external-mcp",
    objective: "look up current documentation through remote tools",
    requiredFunctions: ["search documentation"],
    desiredInputs: ["query"],
    desiredOutputs: ["documentation"],
    purpose: "research",
    urgency: "high-value",
    acquisitionAllowed: true,
    maxRisk: "high",
    ...(policyKinds ? { policy: { acceptableKinds: policyKinds } } : {}),
    requirementRefs: [],
    gapRefs: []
  };
}

const VALID_CATALOG = JSON.stringify([
  {
    id: "docs.search",
    name: "docs_search",
    description: "Search trusted public product documentation",
    revision: "2026-10-30.r1",
    url: "https://mcp.example.test/mcp",
    functions: ["search documentation", "read documentation"],
    accepts: ["query"],
    produces: ["documentation"]
  },
  {
    id: "status.lookup",
    name: "status_lookup",
    description: "Read public service status",
    revision: "status-r7",
    url: "https://status.example.test/mcp",
    functions: ["read service status"]
  }
]);

test("external MCP catalog parses into deterministic bounded mcp-registry candidates", async () => {
  const { parseExternalMcpCatalogJson, ExternalMcpCatalogDiscoveryProvider } = await loadModule();
  const entries = parseExternalMcpCatalogJson(VALID_CATALOG);
  const provider = new ExternalMcpCatalogDiscoveryProvider(entries);

  assert.equal(provider.id, "external-mcp-catalog");
  const candidates = await provider.discover(need(["mcp"]));
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map(candidate => ({
      id: candidate.id,
      sourceType: candidate.sourceType,
      sourceUri: candidate.sourceUri,
      candidateKind: candidate.candidateKind,
      revision: candidate.resolvedRevision,
      status: candidate.status
    })),
    [
      {
        id: "mcp-registry:docs.search",
        sourceType: "mcp-registry",
        sourceUri: "mcp-registry:docs.search@2026-10-30.r1",
        candidateKind: "mcp",
        revision: "2026-10-30.r1",
        status: "discovered"
      },
      {
        id: "mcp-registry:status.lookup",
        sourceType: "mcp-registry",
        sourceUri: "mcp-registry:status.lookup@status-r7",
        candidateKind: "mcp",
        revision: "status-r7",
        status: "discovered"
      }
    ]
  );
  assert.match(candidates[0]!.contentHash ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.match(candidates[0]!.description ?? "", /search documentation/);

  const reordered = JSON.stringify([{
    functions: ["search documentation", "read documentation"],
    url: "https://mcp.example.test/mcp",
    revision: "2026-10-30.r1",
    description: "Search trusted public product documentation",
    name: "docs_search",
    id: "docs.search",
    produces: ["documentation"],
    accepts: ["query"]
  }]);
  const reorderedCandidate = (await new ExternalMcpCatalogDiscoveryProvider(
    parseExternalMcpCatalogJson(reordered)
  ).discover(need()))[0]!;
  assert.equal(reorderedCandidate.contentHash, candidates[0]!.contentHash);

  assert.deepEqual(await provider.discover(need(["skill"])), []);
});

test("external MCP catalog fails closed on mutable or ambiguous remote identity", async () => {
  const { parseExternalMcpCatalogJson, ExternalMcpCatalogDiscoveryProvider } = await loadModule();

  for (const invalidUrl of [
    "http://mcp.example.test/mcp",
    "https://user:secret@mcp.example.test/mcp",
    "https://mcp.example.test/mcp?token=secret",
    "https://mcp.example.test/mcp#fragment"
  ]) {
    const value = JSON.stringify([{
      id: "bad.remote",
      name: "bad_remote",
      description: "bad remote",
      revision: "r1",
      url: invalidUrl,
      functions: ["search documentation"]
    }]);
    assert.throws(() => parseExternalMcpCatalogJson(value));
  }

  assert.throws(() => parseExternalMcpCatalogJson(JSON.stringify([{
    id: "bad.revision",
    name: "bad_revision",
    description: "bad revision",
    revision: "../mutable",
    url: "https://mcp.example.test/mcp",
    functions: ["search documentation"]
  }])), /revision is unsafe/);

  const duplicateName = parseExternalMcpCatalogJson(JSON.stringify([
    {
      id: "one",
      name: "same_name",
      description: "one",
      revision: "r1",
      url: "https://one.example.test/mcp",
      functions: ["one"]
    },
    {
      id: "two",
      name: "same_name",
      description: "two",
      revision: "r2",
      url: "https://two.example.test/mcp",
      functions: ["two"]
    }
  ]));
  assert.throws(() => new ExternalMcpCatalogDiscoveryProvider(duplicateName), /Duplicate external MCP server name/);
});

test("external MCP catalog input is strictly bounded", async () => {
  const { parseExternalMcpCatalogJson } = await loadModule();
  assert.deepEqual(parseExternalMcpCatalogJson(undefined), []);
  assert.throws(() => parseExternalMcpCatalogJson("{}"), /must be a JSON array/);
  assert.throws(() => parseExternalMcpCatalogJson(JSON.stringify([{
    id: "missing.functions",
    name: "missing_functions",
    description: "missing functions",
    revision: "r1",
    url: "https://mcp.example.test/mcp",
    functions: []
  }])), /functions must contain 1-64 strings/);

  const tooMany = Array.from({ length: 129 }, (_, index) => ({
    id: `server-${index}`,
    name: `server_${index}`,
    description: `server ${index}`,
    revision: "r1",
    url: `https://server-${index}.example.test/mcp`,
    functions: ["lookup"]
  }));
  assert.throws(() => parseExternalMcpCatalogJson(JSON.stringify(tooMany)), /exceeds 128 entries/);
});
