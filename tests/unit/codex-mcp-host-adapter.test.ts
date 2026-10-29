import assert from "node:assert/strict";
import test from "node:test";
import { compileCodexMcpProjection } from "../../src/hosts/codex/codex-mcp-host-adapter.ts";
import type { HostMcpServer } from "../../src/hosts/host-adapter.ts";

const stdio: HostMcpServer = {
  transport: "stdio",
  name: "docs_server",
  command: "/opt/mission/mcp-docs",
  args: ["--mode", "read-only"],
  env: []
};

const http: HostMcpServer = {
  transport: "http",
  name: "remote_docs",
  url: "https://mcp.example.test/mcp",
  headers: []
};

test("Codex MCP projection uses process-level mcp_servers config without secret material", () => {
  const projection = compileCodexMcpProjection([stdio, http]);
  assert.match(projection.identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(projection.args, [
    "-c", 'mcp_servers.docs_server.command="/opt/mission/mcp-docs"',
    "-c", 'mcp_servers.docs_server.args=["--mode","read-only"]',
    "-c", "mcp_servers.docs_server.enabled=true",
    "-c", 'mcp_servers.remote_docs.url="https://mcp.example.test/mcp"',
    "-c", "mcp_servers.remote_docs.enabled=true"
  ]);
});

test("Codex MCP projection fails closed for secret-bearing MCP configs", () => {
  assert.throws(
    () => compileCodexMcpProjection([{ ...stdio, env: [{ name: "TOKEN", value: "secret" }] }]),
    /secure provider-native secret projection is not implemented/
  );
  assert.throws(
    () => compileCodexMcpProjection([{ ...http, headers: [{ name: "Authorization", value: "Bearer secret" }] }]),
    /secure provider-native secret projection is not implemented/
  );
});

test("Codex MCP projection rejects unsafe names, commands, duplicate names and credential-bearing URLs", () => {
  assert.throws(
    () => compileCodexMcpProjection([{ ...stdio, name: "bad.name" }]),
    /server name is unsafe/
  );
  assert.throws(
    () => compileCodexMcpProjection([{ ...stdio, command: "relative-command" }]),
    /command must be an absolute path/
  );
  assert.throws(
    () => compileCodexMcpProjection([stdio, { ...http, name: stdio.name }]),
    /Duplicate Codex MCP server name/
  );
  assert.throws(
    () => compileCodexMcpProjection([{ ...http, url: "https://user:password@example.test/mcp" }]),
    /credential-bearing URL/
  );
});
