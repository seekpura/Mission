import type {
  CapabilityDescriptor,
  CapabilityEnvironment
} from "../domain/capability.ts";

export interface HostCapabilityGraphSource {
  revision: number;
  host: { type: string; version?: string };
  capabilities: CapabilityDescriptor[];
  shellAvailable?: boolean;
  filesystemAvailable?: boolean;
  browserAvailable?: boolean;
}

export type CapabilityGraphNode =
  | {
      id: string;
      kind: "capability";
      capability: CapabilityDescriptor;
    }
  | {
      id: string;
      kind: "environment";
      environment: CapabilityEnvironment;
      available: boolean | "unknown";
    }
  | {
      id: string;
      kind: "route";
      executorId: string;
    };

export type CapabilityGraphRelation = "requires" | "requires-environment" | "routes-via";

export interface CapabilityGraphEdge {
  from: string;
  to: string;
  relation: CapabilityGraphRelation;
}

export interface HostCapabilityGraph {
  revision: number;
  host: { type: string; version?: string };
  nodes: CapabilityGraphNode[];
  edges: CapabilityGraphEdge[];
}

export function buildHostCapabilityGraph(source: HostCapabilityGraphSource): HostCapabilityGraph {
  const capabilityIds = new Set<string>();
  const nodes: CapabilityGraphNode[] = [];
  const edges: CapabilityGraphEdge[] = [];

  for (const capability of source.capabilities) {
    if (!capability.id.trim()) throw new Error("Capability graph cannot contain an empty capability id");
    if (capabilityIds.has(capability.id)) throw new Error(`Capability graph contains duplicate capability id: ${capability.id}`);
    capabilityIds.add(capability.id);
    nodes.push({
      id: capabilityNodeId(capability.id),
      kind: "capability",
      capability: cloneCapability(capability)
    });
  }

  const environments: Array<[CapabilityEnvironment, boolean | undefined]> = [
    ["shell", source.shellAvailable],
    ["filesystem", source.filesystemAvailable],
    ["browser", source.browserAvailable]
  ];
  for (const [environment, available] of environments) {
    nodes.push({
      id: environmentNodeId(environment),
      kind: "environment",
      environment,
      available: available === undefined ? "unknown" : available
    });
  }

  const routeIds = new Set<string>();
  for (const capability of source.capabilities) {
    const from = capabilityNodeId(capability.id);
    for (const required of capability.constraints?.requiresCapabilityRefs ?? []) {
      edges.push({ from, to: capabilityNodeId(required), relation: "requires" });
    }
    for (const environment of capability.constraints?.requiredEnvironment ?? []) {
      edges.push({ from, to: environmentNodeId(environment), relation: "requires-environment" });
    }
    for (const executorId of capability.routing?.executorIds ?? []) {
      const clean = executorId.trim();
      if (!clean) continue;
      if (!routeIds.has(clean)) {
        routeIds.add(clean);
        nodes.push({ id: routeNodeId(clean), kind: "route", executorId: clean });
      }
      edges.push({ from, to: routeNodeId(clean), relation: "routes-via" });
    }
  }

  edges.sort((a, b) => `${a.from}|${a.relation}|${a.to}`.localeCompare(`${b.from}|${b.relation}|${b.to}`));
  return {
    revision: source.revision,
    host: { ...source.host },
    nodes,
    edges
  };
}

export function capabilityDescriptors(graph: HostCapabilityGraph): CapabilityDescriptor[] {
  return graph.nodes
    .filter((node): node is Extract<CapabilityGraphNode, { kind: "capability" }> => node.kind === "capability")
    .map(node => node.capability);
}

export function capabilityNode(graph: HostCapabilityGraph, capabilityId: string) {
  return graph.nodes.find(
    (node): node is Extract<CapabilityGraphNode, { kind: "capability" }> =>
      node.kind === "capability" && node.capability.id === capabilityId
  );
}

export function environmentAvailability(
  graph: HostCapabilityGraph,
  environment: CapabilityEnvironment
): boolean | "unknown" {
  const node = graph.nodes.find(
    (candidate): candidate is Extract<CapabilityGraphNode, { kind: "environment" }> =>
      candidate.kind === "environment" && candidate.environment === environment
  );
  return node?.available ?? "unknown";
}

export function requiredCapabilityRefs(graph: HostCapabilityGraph, capabilityId: string): string[] {
  const from = capabilityNodeId(capabilityId);
  return graph.edges
    .filter(edge => edge.from === from && edge.relation === "requires")
    .map(edge => stripCapabilityNodeId(edge.to));
}

export function routedExecutorIds(graph: HostCapabilityGraph, capabilityId: string): string[] {
  const from = capabilityNodeId(capabilityId);
  return graph.edges
    .filter(edge => edge.from === from && edge.relation === "routes-via")
    .map(edge => stripRouteNodeId(edge.to));
}

export function capabilityNodeId(capabilityId: string): string {
  return `capability:${capabilityId}`;
}

export function environmentNodeId(environment: CapabilityEnvironment): string {
  return `environment:${environment}`;
}

export function routeNodeId(executorId: string): string {
  return `route:${executorId}`;
}

function stripCapabilityNodeId(value: string): string {
  return value.startsWith("capability:") ? value.slice("capability:".length) : value;
}

function stripRouteNodeId(value: string): string {
  return value.startsWith("route:") ? value.slice("route:".length) : value;
}

function cloneCapability(capability: CapabilityDescriptor): CapabilityDescriptor {
  return {
    ...capability,
    permissions: [...capability.permissions],
    functions: capability.functions ? [...capability.functions] : undefined,
    accepts: capability.accepts ? [...capability.accepts] : undefined,
    produces: capability.produces ? [...capability.produces] : undefined,
    constraints: capability.constraints ? {
      ...capability.constraints,
      requiredEnvironment: capability.constraints.requiredEnvironment ? [...capability.constraints.requiredEnvironment] : undefined,
      requiresCapabilityRefs: capability.constraints.requiresCapabilityRefs ? [...capability.constraints.requiresCapabilityRefs] : undefined,
      supportedPurposes: capability.constraints.supportedPurposes ? [...capability.constraints.supportedPurposes] : undefined
    } : undefined,
    routing: capability.routing ? {
      ...capability.routing,
      executorIds: capability.routing.executorIds ? [...capability.routing.executorIds] : undefined
    } : undefined,
    cost: capability.cost ? { ...capability.cost } : undefined,
    native: capability.native ? {
      ...capability.native,
      approvalModes: capability.native.approvalModes ? [...capability.native.approvalModes] : undefined,
      features: capability.native.features ? [...capability.native.features] : undefined,
      persistence: capability.native.persistence ? [...capability.native.persistence] : undefined
    } : undefined,
    provenance: capability.provenance ? { ...capability.provenance } : undefined
  };
}
