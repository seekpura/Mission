import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { buildHostCapabilityGraph } from "../../core/capabilities/capability-graph.ts";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
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
  HostMcpServer
} from "../host-adapter.ts";
import {
  CodexNativeCapabilityHostAdapter,
  type CodexNativeCapabilityHostOptions
} from "./codex-native-host-adapter.ts";

const MAX_MCP_SERVERS = 16;
const SAFE_NAME = /^[A-Za-z0-9_-]{1,32}$/;

interface CodexMcpProjection {
  args: string[];
  identity: string;
}

/**
 * Provider-native bridge from Mission's trusted HostMcpServer contract into
 * Codex's process-level `mcp_servers` configuration.
 *
 * Secrets intentionally fail closed for Codex in this adapter. Codex accepts
 * literal env/header values in config or references to its own process env;
 * both routes would widen the secret boundary beyond the selected MCP server.
 * DeepSeek ACP keeps its existing provider-native secret-bearing MCP delivery.
 */
export class CodexMcpHostAdapter implements HostAdapter {
  private readonly options: CodexNativeCapabilityHostOptions;
  private readonly base: CodexNativeCapabilityHostAdapter;
  private readonly projected = new Map<string, CodexNativeCapabilityHostAdapter>();
  private readonly handles = new Map<string, CodexNativeCapabilityHostAdapter>();

  constructor(options: CodexNativeCapabilityHostOptions = {}) {
    this.options = cloneOptions(options);
    this.base = new CodexNativeCapabilityHostAdapter(this.options);
  }

  describeHost(): Promise<HostDescriptor> {
    return this.base.describeHost();
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    const snapshot = await this.base.snapshotEnvironment();
    const capabilities = snapshot.capabilities.map(capability =>
      capability.id === "openai-codex.app-server-agent"
        ? withMcpDeliverySemantics(capability)
        : capability
    );
    return {
      ...snapshot,
      capabilities,
      capabilityGraph: buildHostCapabilityGraph({
        revision: snapshot.revision,
        host: snapshot.host,
        capabilities,
        shellAvailable: snapshot.shellAvailable,
        filesystemAvailable: snapshot.filesystemAvailable,
        browserAvailable: snapshot.browserAvailable
      })
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const adapter = this.adapterFor(request.mcpServers ?? []);
    const handle = await adapter.createAgent(withoutMcp(request));
    this.bind(handle, adapter);
    return handle;
  }

  async resumeAgent(request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    const alreadyBound = this.handles.get(request.handleId);
    const adapter = alreadyBound ?? this.adapterFor(request.mcpServers ?? []);
    const result = await adapter.resumeAgent(withoutMcp(request));
    if (result.status === "resumed") this.bind(result.handle, adapter);
    return result;
  }

  steerAgent(handle: HostAgentHandle, delta: ContextDelta): Promise<void> {
    return this.requireHandle(handle).steerAgent(handle, delta);
  }

  cancelAgent(handle: HostAgentHandle): Promise<void> {
    return this.requireHandle(handle).cancelAgent(handle);
  }

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const adapter = this.requireHandle(handle);
    try {
      for await (const event of adapter.observeAgent(handle)) yield event;
    } finally {
      this.handles.delete(handle.id);
    }
  }

  invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return this.base.invokeHostCapability(request);
  }

  requestUserApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.base.requestUserApproval(request);
  }

  private adapterFor(servers: HostMcpServer[]): CodexNativeCapabilityHostAdapter {
    if (servers.length === 0) return this.base;
    const projection = compileCodexMcpProjection(servers);
    let adapter = this.projected.get(projection.identity);
    if (!adapter) {
      adapter = new CodexNativeCapabilityHostAdapter({
        ...cloneOptions(this.options),
        argsPrefix: [...(this.options.argsPrefix ?? []), ...projection.args]
      });
      this.projected.set(projection.identity, adapter);
    }
    return adapter;
  }

  private bind(handle: HostAgentHandle, adapter: CodexNativeCapabilityHostAdapter): void {
    const current = this.handles.get(handle.id);
    if (current && current !== adapter) {
      throw new Error(`Codex handle ${handle.id} is already bound to another MCP projection`);
    }
    this.handles.set(handle.id, adapter);
  }

  private requireHandle(handle: HostAgentHandle): CodexNativeCapabilityHostAdapter {
    const adapter = this.handles.get(handle.id);
    if (!adapter) throw new Error(`Unknown Codex MCP host handle: ${handle.id}`);
    return adapter;
  }
}

export function compileCodexMcpProjection(servers: readonly HostMcpServer[]): CodexMcpProjection {
  if (servers.length > MAX_MCP_SERVERS) throw new Error(`Codex MCP projection exceeds ${MAX_MCP_SERVERS} servers`);
  const names = new Set<string>();
  const args: string[] = [];
  const identityShape: unknown[] = [];

  for (const server of servers) {
    if (!SAFE_NAME.test(server.name)) throw new Error(`Codex MCP server name is unsafe: ${server.name}`);
    if (names.has(server.name)) throw new Error(`Duplicate Codex MCP server name: ${server.name}`);
    names.add(server.name);
    const root = `mcp_servers.${server.name}`;

    if (server.transport === "stdio") {
      if (!isAbsolute(server.command) || server.command.includes("\0")) {
        throw new Error(`Codex stdio MCP ${server.name} command must be an absolute path without NUL`);
      }
      if (server.args.some(value => value.includes("\0"))) {
        throw new Error(`Codex stdio MCP ${server.name} args contain NUL`);
      }
      if (server.env.length > 0) {
        throw new Error(
          `Codex MCP ${server.name} contains environment secrets; secure provider-native secret projection is not implemented`
        );
      }
      args.push("-c", `${root}.command=${tomlString(server.command)}`);
      if (server.args.length > 0) args.push("-c", `${root}.args=${tomlStringArray(server.args)}`);
      args.push("-c", `${root}.enabled=true`);
      identityShape.push({ transport: "stdio", name: server.name, command: server.command, args: server.args });
      continue;
    }

    if (server.headers.length > 0) {
      throw new Error(
        `Codex MCP ${server.name} contains HTTP header secrets; secure provider-native secret projection is not implemented`
      );
    }
    const url = new URL(server.url);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
      throw new Error(`Codex HTTP MCP ${server.name} has an unsupported or credential-bearing URL`);
    }
    args.push("-c", `${root}.url=${tomlString(url.toString())}`);
    args.push("-c", `${root}.enabled=true`);
    identityShape.push({ transport: "http", name: server.name, url: url.toString() });
  }

  const identity = createHash("sha256").update(JSON.stringify(identityShape)).digest("hex");
  return { args, identity };
}

function withoutMcp<T extends AgentCreateRequest | AgentResumeRequest>(request: T): T {
  const clone = { ...request } as T & { mcpServers?: HostMcpServer[] };
  delete clone.mcpServers;
  return clone;
}

function withMcpDeliverySemantics(capability: CapabilityDescriptor): CapabilityDescriptor {
  const functions = new Set(capability.functions ?? []);
  functions.add("deliver trusted MCP servers to agent session");
  const features = new Set(capability.native?.features ?? []);
  features.add("provider-native-mcp-config");
  features.add("mcp-stdio-no-secret");
  features.add("mcp-http-no-secret");
  return {
    ...capability,
    functions: [...functions],
    native: {
      ...(capability.native ?? {}),
      features: [...features]
    }
  };
}

function cloneOptions(options: CodexNativeCapabilityHostOptions): CodexNativeCapabilityHostOptions {
  return {
    ...options,
    ...(options.argsPrefix ? { argsPrefix: [...options.argsPrefix] } : {}),
    ...(options.env ? { env: { ...options.env } } : {})
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: readonly string[]): string {
  return `[${values.map(tomlString).join(",")}]`;
}
