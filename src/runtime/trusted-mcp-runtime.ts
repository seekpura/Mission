import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { CapabilityDescriptor } from "../core/domain/capability.ts";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor,
  HostMcpNameValue,
  HostMcpServer
} from "../hosts/deepseek/host-adapter.ts";

export type TrustedMcpServerConfig =
  | {
      id: string;
      name: string;
      description: string;
      revision: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: HostMcpNameValue[];
    }
  | {
      id: string;
      name: string;
      description: string;
      revision: string;
      transport: "http";
      url: string;
      headers?: HostMcpNameValue[];
    };

export interface TrustedMcpRegistryOptions {
  allowInsecureHttp?: boolean;
}

interface TrustedMcpEntry {
  descriptor: CapabilityDescriptor;
  server: HostMcpServer;
  projection: McpProjectionEntry;
}

interface McpProjectionEntry {
  capabilityId: string;
  name: string;
  transport: HostMcpServer["transport"];
  revision: string;
  configShapeHash: string;
}

interface McpProjectionReceipt {
  schemaVersion: 1;
  capabilities: McpProjectionEntry[];
}

const MCP_RECEIPT = ".mission-mcp-projection.json";
const MCP_ID = /^trusted-mcp:[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const MCP_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Runtime-owned allowlist for MCP servers that an operator has configured as
 * trusted. Secret env/header values stay only inside this in-memory registry.
 */
export class TrustedMcpRegistry {
  private readonly entries = new Map<string, TrustedMcpEntry>();

  constructor(configs: TrustedMcpServerConfig[], options: TrustedMcpRegistryOptions = {}) {
    const names = new Set<string>();
    for (const config of configs) {
      const entry = normalizeConfig(config, options);
      if (this.entries.has(config.id)) throw new Error(`Duplicate trusted MCP capability id: ${config.id}`);
      if (names.has(config.name)) throw new Error(`Duplicate trusted MCP server name: ${config.name}`);
      names.add(config.name);
      this.entries.set(config.id, entry);
    }
  }

  capabilities(): CapabilityDescriptor[] {
    return [...this.entries.values()].map(entry => ({ ...entry.descriptor, permissions: [...entry.descriptor.permissions] }));
  }

  select(capabilityRefs: string[]): { servers: HostMcpServer[]; projection: McpProjectionEntry[] } {
    const servers: HostMcpServer[] = [];
    const projection: McpProjectionEntry[] = [];
    const seen = new Set<string>();
    for (const ref of capabilityRefs) {
      if (seen.has(ref)) continue;
      seen.add(ref);
      const entry = this.entries.get(ref);
      if (!entry) {
        if (ref.startsWith("trusted-mcp:")) throw new Error(`Unknown trusted MCP capability reference: ${ref}`);
        continue;
      }
      servers.push(cloneServer(entry.server));
      projection.push({ ...entry.projection });
    }
    return { servers, projection };
  }
}

/**
 * Adds trusted MCP capabilities to the host catalog and delivers only the MCP
 * servers explicitly authorized in AgentCreateRequest.allowedCapabilityRefs.
 */
export class TrustedMcpHostAdapter implements HostAdapter {
  private readonly base: HostAdapter;
  private readonly registry: TrustedMcpRegistry;

  constructor(base: HostAdapter, registry: TrustedMcpRegistry) {
    this.base = base;
    this.registry = registry;
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const snapshot = await this.base.snapshotEnvironment();
    const trusted = this.registry.capabilities();
    const ids = new Set(snapshot.capabilities.map(capability => capability.id));
    for (const capability of trusted) {
      if (ids.has(capability.id)) throw new Error(`Trusted MCP capability id collides with host capability: ${capability.id}`);
      ids.add(capability.id);
    }
    return { ...snapshot, capabilities: [...snapshot.capabilities, ...trusted] };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    if (request.mcpServers && request.mcpServers.length > 0) {
      throw new Error("Host MCP declarations are reserved for TrustedMcpHostAdapter delivery");
    }
    const selected = this.registry.select(request.allowedCapabilityRefs);
    writeOrValidateReceipt(request, selected.projection, "create");
    return this.base.createAgent({ ...request, mcpServers: selected.servers });
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    if (request.mcpServers && request.mcpServers.length > 0) {
      return { status: "failed", reason: "Host MCP declarations are reserved for TrustedMcpHostAdapter delivery" };
    }
    try {
      const selected = this.registry.select(request.allowedCapabilityRefs);
      writeOrValidateReceipt(request, selected.projection, "resume");
      return this.base.resumeAgent({ ...request, mcpServers: selected.servers });
    } catch (error) {
      return { status: "failed", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.base.steerAgent(handle, delta);
  }

  cancelAgent(handle: HostAgentHandle): Promise<void> {
    return this.base.cancelAgent(handle);
  }

  observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    return this.base.observeAgent(handle);
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }
}

export function parseTrustedMcpServersJson(
  value: string | undefined,
  options: TrustedMcpRegistryOptions = {}
): TrustedMcpServerConfig[] {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`MISSION_TRUSTED_MCP_SERVERS_JSON must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed)) throw new Error("MISSION_TRUSTED_MCP_SERVERS_JSON must be a JSON array");
  const configs = parsed.map((item, index) => parseConfig(item, index));
  // Construct once here so invalid URLs, commands, headers, duplicates, etc.
  // fail during bootstrap rather than at the first Worker dispatch.
  void new TrustedMcpRegistry(configs, options);
  return configs;
}

function parseConfig(value: unknown, index: number): TrustedMcpServerConfig {
  const item = objectValue(value, `trustedMcpServers[${index}]`);
  const common = {
    id: nonEmptyString(item.id, `trustedMcpServers[${index}].id`),
    name: nonEmptyString(item.name, `trustedMcpServers[${index}].name`),
    description: nonEmptyString(item.description, `trustedMcpServers[${index}].description`),
    revision: nonEmptyString(item.revision, `trustedMcpServers[${index}].revision`)
  };
  const transport = nonEmptyString(item.transport, `trustedMcpServers[${index}].transport`);
  if (transport === "stdio") {
    return {
      ...common,
      transport,
      command: nonEmptyString(item.command, `trustedMcpServers[${index}].command`),
      args: optionalStringArray(item.args, `trustedMcpServers[${index}].args`),
      env: optionalNameValueArray(item.env, `trustedMcpServers[${index}].env`)
    };
  }
  if (transport === "http") {
    return {
      ...common,
      transport,
      url: nonEmptyString(item.url, `trustedMcpServers[${index}].url`),
      headers: optionalNameValueArray(item.headers, `trustedMcpServers[${index}].headers`)
    };
  }
  throw new Error(`trustedMcpServers[${index}].transport must be stdio or http`);
}

function normalizeConfig(config: TrustedMcpServerConfig, options: TrustedMcpRegistryOptions): TrustedMcpEntry {
  if (!MCP_ID.test(config.id)) throw new Error(`Trusted MCP id must use trusted-mcp:<safe-name>: ${config.id}`);
  if (!MCP_NAME.test(config.name)) throw new Error(`Trusted MCP server name must match ${MCP_NAME}: ${config.name}`);
  if (!config.description.trim()) throw new Error(`Trusted MCP ${config.id} requires a description`);
  if (!/^[A-Za-z0-9._:@+/-]{1,160}$/.test(config.revision) || config.revision.includes("..")) {
    throw new Error(`Trusted MCP ${config.id} requires a safe non-secret revision label`);
  }

  if (config.transport === "stdio") {
    if (!isAbsolute(config.command) || config.command.includes("\0")) {
      throw new Error(`Trusted stdio MCP ${config.id} command must be an absolute path without NUL`);
    }
    const args = [...(config.args ?? [])];
    if (args.some(argument => argument.includes("\0"))) throw new Error(`Trusted stdio MCP ${config.id} args contain NUL`);
    const env = validateNameValues(config.env ?? [], "environment", config.id);
    const server: HostMcpServer = { transport: "stdio", name: config.name, command: config.command, args, env };
    return makeEntry(config, server, "mcp-stdio-process");
  }

  const url = new URL(config.url);
  if (url.username || url.password) throw new Error(`Trusted HTTP MCP ${config.id} URL must not contain credentials`);
  if (url.protocol !== "https:" && !(options.allowInsecureHttp === true && url.protocol === "http:")) {
    throw new Error(`Trusted HTTP MCP ${config.id} requires HTTPS unless insecure HTTP is explicitly enabled`);
  }
  const headers = validateNameValues(config.headers ?? [], "header", config.id);
  const server: HostMcpServer = { transport: "http", name: config.name, url: url.toString(), headers };
  return makeEntry(config, server, "mcp-http-network");
}

function makeEntry(
  config: TrustedMcpServerConfig,
  server: HostMcpServer,
  permission: string
): TrustedMcpEntry {
  const descriptor: CapabilityDescriptor = {
    id: config.id,
    kind: "mcp",
    name: config.name,
    description: config.description,
    hostNative: true,
    available: true,
    invocationRef: `trusted-mcp:${config.name}`,
    permissions: [permission],
    revision: config.revision,
    scope: "host"
  };
  const projection: McpProjectionEntry = {
    capabilityId: config.id,
    name: config.name,
    transport: server.transport,
    revision: config.revision,
    configShapeHash: shapeHash(server)
  };
  return { descriptor, server, projection };
}

function validateNameValues(
  values: HostMcpNameValue[],
  kind: "environment" | "header",
  capabilityId: string
): HostMcpNameValue[] {
  const seen = new Set<string>();
  return values.map(entry => {
    if (typeof entry.name !== "string" || typeof entry.value !== "string") {
      throw new Error(`Trusted MCP ${capabilityId} ${kind} entry must contain string name/value`);
    }
    if (kind === "environment") {
      if (!entry.name || entry.name.includes("=") || entry.name.includes("\0") || entry.value.includes("\0")) {
        throw new Error(`Trusted MCP ${capabilityId} contains invalid environment entry`);
      }
    } else {
      try {
        validateHeaderName(entry.name);
        validateHeaderValue(entry.name, entry.value);
      } catch {
        throw new Error(`Trusted MCP ${capabilityId} contains invalid header entry`);
      }
    }
    const identity = kind === "header" ? entry.name.toLowerCase() : entry.name;
    if (seen.has(identity)) throw new Error(`Trusted MCP ${capabilityId} contains duplicate ${kind} name: ${entry.name}`);
    seen.add(identity);
    return { name: entry.name, value: entry.value };
  });
}

function shapeHash(server: HostMcpServer): string {
  const safeShape = server.transport === "stdio"
    ? {
        transport: server.transport,
        name: server.name,
        command: server.command,
        args: server.args,
        envNames: server.env.map(entry => entry.name)
      }
    : {
        transport: server.transport,
        name: server.name,
        url: server.url,
        headerNames: server.headers.map(entry => entry.name.toLowerCase())
      };
  return `sha256:${createHash("sha256").update(JSON.stringify(safeShape)).digest("hex")}`;
}

function cloneServer(server: HostMcpServer): HostMcpServer {
  return server.transport === "stdio"
    ? {
        transport: "stdio",
        name: server.name,
        command: server.command,
        args: [...server.args],
        env: server.env.map(entry => ({ ...entry }))
      }
    : {
        transport: "http",
        name: server.name,
        url: server.url,
        headers: server.headers.map(entry => ({ ...entry }))
      };
}

function writeOrValidateReceipt(
  request: AgentCreateRequest | AgentResumeRequest,
  projection: McpProjectionEntry[],
  mode: "create" | "resume"
): void {
  if (!request.workspaceRoot) {
    if (projection.length > 0) throw new Error("Trusted MCP delivery requires an explicit Host workspaceRoot");
    return;
  }
  const workspace = resolve(request.workspaceRoot);
  const receiptPath = join(workspace, MCP_RECEIPT);
  const receipt: McpProjectionReceipt = {
    schemaVersion: 1,
    capabilities: projection.map(item => ({ ...item }))
  };
  if (mode === "resume") {
    if (!existsSync(receiptPath)) {
      throw new Error(`Trusted MCP recovery receipt is missing: ${receiptPath}`);
    }
    const info = lstatSync(receiptPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Trusted MCP recovery receipt is unsafe: ${receiptPath}`);
    const previous = parseReceipt(readFileSync(receiptPath, "utf8"), receiptPath);
    if (JSON.stringify(previous) !== JSON.stringify(receipt)) {
      throw new Error("Trusted MCP configuration/revision changed since execution was bound; refusing session recovery");
    }
    return;
  }
  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function parseReceipt(value: string, path: string): McpProjectionReceipt {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error(`Trusted MCP projection receipt is invalid JSON: ${path}`); }
  const object = objectValue(parsed, "MCP projection receipt");
  if (object.schemaVersion !== 1 || !Array.isArray(object.capabilities)) {
    throw new Error(`Trusted MCP projection receipt has unsupported shape: ${path}`);
  }
  const capabilities = object.capabilities.map((entry, index) => {
    const item = objectValue(entry, `MCP projection receipt capabilities[${index}]`);
    const transport = nonEmptyString(item.transport, `MCP projection receipt capabilities[${index}].transport`);
    if (transport !== "stdio" && transport !== "http") throw new Error(`Invalid MCP projection transport: ${transport}`);
    return {
      capabilityId: nonEmptyString(item.capabilityId, `MCP projection receipt capabilities[${index}].capabilityId`),
      name: nonEmptyString(item.name, `MCP projection receipt capabilities[${index}].name`),
      transport,
      revision: nonEmptyString(item.revision, `MCP projection receipt capabilities[${index}].revision`),
      configShapeHash: nonEmptyString(item.configShapeHash, `MCP projection receipt capabilities[${index}].configShapeHash`)
    } satisfies McpProjectionEntry;
  });
  return { schemaVersion: 1, capabilities };
}

function optionalStringArray(value: unknown, path: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error(`${path} must be a string array`);
  return [...value];
}

function optionalNameValueArray(value: unknown, path: string): HostMcpNameValue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((item, index) => {
    const object = objectValue(item, `${path}[${index}]`);
    return {
      name: nonEmptyString(object.name, `${path}[${index}].name`),
      value: stringValue(object.value, `${path}[${index}].value`)
    };
  });
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${path} must be a non-empty string`);
  return value.trim();
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
  return value;
}
