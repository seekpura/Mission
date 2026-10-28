import type {
  CapabilityCostClass,
  CapabilityDeliveryMode,
  CapabilityDescriptor,
  CapabilityIsolationLevel,
  CapabilityNetworkAccess,
  CapabilityPurpose,
  CapabilitySemantics,
  CapabilitySideEffectLevel,
  CapabilityTrustLevel
} from "../domain/capability.ts";

export interface CapabilityGraphNode {
  id: string;
  descriptor: CapabilityDescriptor;
  semantics: CapabilitySemantics;
}

export interface CapabilityGraphEdge {
  from: string;
  to: string;
  relation: "requires";
}

export interface CapabilityGraph {
  nodes: Map<string, CapabilityGraphNode>;
  edges: CapabilityGraphEdge[];
}

const ALL_PURPOSES: CapabilityPurpose[] = ["production", "verification", "research", "integration"];

export function buildCapabilityGraph(capabilities: CapabilityDescriptor[]): CapabilityGraph {
  const nodes = new Map<string, CapabilityGraphNode>();
  for (const descriptor of capabilities) {
    if (nodes.has(descriptor.id)) throw new Error(`Duplicate capability id in graph: ${descriptor.id}`);
    nodes.set(descriptor.id, {
      id: descriptor.id,
      descriptor,
      semantics: normalizeCapabilitySemantics(descriptor)
    });
  }

  const edges: CapabilityGraphEdge[] = [];
  for (const node of nodes.values()) {
    for (const dependency of node.semantics.requiresCapabilityRefs ?? []) {
      edges.push({ from: node.id, to: dependency, relation: "requires" });
    }
  }
  return { nodes, edges };
}

export function normalizeCapabilitySemantics(descriptor: CapabilityDescriptor): CapabilitySemantics {
  const explicit = descriptor.semantics;
  return {
    functions: uniqueStrings(explicit?.functions?.length ? explicit.functions : [descriptor.name, descriptor.description]),
    inputTypes: uniqueStrings(explicit?.inputTypes ?? []),
    outputTypes: uniqueStrings(explicit?.outputTypes ?? []),
    purposes: unique(explicit?.purposes?.length ? explicit.purposes : ALL_PURPOSES),
    deliveryModes: unique(explicit?.deliveryModes?.length ? explicit.deliveryModes : inferDelivery(descriptor)),
    isolation: explicit?.isolation ?? inferIsolation(descriptor),
    networkAccess: explicit?.networkAccess ?? inferNetwork(descriptor),
    sideEffectLevel: explicit?.sideEffectLevel ?? inferSideEffects(descriptor),
    trust: explicit?.trust ?? inferTrust(descriptor),
    costClass: explicit?.costClass ?? "unknown",
    ...(explicit?.requiresCapabilityRefs?.length
      ? { requiresCapabilityRefs: uniqueStrings(explicit.requiresCapabilityRefs) }
      : {}),
    ...(explicit?.nativeRefs?.length ? { nativeRefs: uniqueStrings(explicit.nativeRefs) } : {})
  };
}

export function missingCapabilityDependencies(graph: CapabilityGraph, node: CapabilityGraphNode): string[] {
  return (node.semantics.requiresCapabilityRefs ?? []).filter(ref => {
    const dependency = graph.nodes.get(ref);
    return !dependency || !dependency.descriptor.available;
  });
}

function inferDelivery(descriptor: CapabilityDescriptor): CapabilityDeliveryMode[] {
  switch (descriptor.kind) {
    case "agent": return ["host-agent-session"];
    case "skill": return ["workspace-skill"];
    case "mcp": {
      const delivery: CapabilityDeliveryMode[] = [];
      if (descriptor.permissions.some(permission => permission.includes("mcp-stdio"))) delivery.push("acp-mcp-stdio");
      if (descriptor.permissions.some(permission => permission.includes("mcp-http"))) delivery.push("acp-mcp-http");
      return delivery.length > 0 ? delivery : ["unknown"];
    }
    case "cli": return ["local-command"];
    case "library": return ["library"];
    case "application": return ["application"];
    case "workflow": return ["workflow"];
    default: return ["unknown"];
  }
}

function inferIsolation(descriptor: CapabilityDescriptor): CapabilityIsolationLevel {
  if (descriptor.permissions.some(permission => permission.includes("container"))) return "container";
  if (descriptor.permissions.some(permission => permission.includes("mcp-http") || permission.includes("remote"))) return "remote";
  if (descriptor.permissions.some(permission => permission.includes("restricted"))) return "restricted";
  if (descriptor.permissions.some(permission => permission.includes("process") || permission.includes("stdio"))) return "process";
  if (descriptor.hostNative) return "host";
  return "unknown";
}

function inferNetwork(descriptor: CapabilityDescriptor): CapabilityNetworkAccess {
  if (descriptor.permissions.some(permission => permission.includes("mcp-http") || permission.includes("remote-service"))) return "remote-service";
  if (descriptor.permissions.some(permission => permission.includes("network") || permission.includes("outbound"))) return "outbound";
  if (descriptor.permissions.some(permission => permission.includes("local-network"))) return "local";
  return "unknown";
}

function inferSideEffects(descriptor: CapabilityDescriptor): CapabilitySideEffectLevel {
  if (descriptor.permissions.some(permission => permission.includes("external") || permission.includes("network") || permission.includes("process"))) return "external";
  if (descriptor.permissions.some(permission => permission.includes("write") || permission.includes("edit"))) return "write";
  if (descriptor.permissions.some(permission => permission.includes("read"))) return "read";
  return "unknown";
}

function inferTrust(descriptor: CapabilityDescriptor): CapabilityTrustLevel {
  if (descriptor.kind === "mcp" && descriptor.id.startsWith("trusted-mcp:")) return "operator-trusted";
  if (descriptor.hostNative) return "host-native";
  if (descriptor.scope === "trusted-cache") return "trusted-cache";
  if (descriptor.scope === "mission") return "mission-acquired";
  return "unknown";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export const CAPABILITY_COST_ORDER: Record<CapabilityCostClass, number> = {
  free: 0,
  low: 1,
  medium: 2,
  high: 3,
  unknown: 4
};

export const CAPABILITY_TRUST_ORDER: Record<CapabilityTrustLevel, number> = {
  "host-native": 4,
  "operator-trusted": 3,
  "trusted-cache": 2,
  "mission-acquired": 1,
  unknown: 0
};

export const CAPABILITY_DELIVERY_MODES: CapabilityDeliveryMode[] = [
  "host-agent-session",
  "workspace-skill",
  "acp-mcp-stdio",
  "acp-mcp-http",
  "local-command",
  "library",
  "application",
  "workflow",
  "unknown"
];
