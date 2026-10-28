import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityDescriptor } from "../../core/domain/capability.ts";
import type { ExecutionRequest, ExecutionResult, ResourceRequest, SideEffectPolicy } from "../../core/domain/execution.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import { HostAgentExecutionBackend, type HostAgentExecutionRequest } from "../../execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend, type HostCapabilityExecutionRequest } from "../../execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend, type LocalCommandExecutionRequest } from "../../execution/local/local-execution-backend.ts";
import { ResourceManager } from "../../execution/resources/resource-manager.ts";
import { ArtifactLeaseManager } from "../../execution/artifacts/artifact-lease-manager.ts";

export type ExecutionRouteKind = "host_agent" | "host_capability" | "local_cli";

export interface ExecutionRoute {
  kind: ExecutionRouteKind;
  reason: string;
  capability?: CapabilityDescriptor;
  sideEffectPolicy: SideEffectPolicy;
  resourceRequest: ResourceRequest;
  requiresApproval: boolean;
}

export interface RoutedExecutionInput {
  work: WorkItem;
  route?: ExecutionRoute;
  capabilities: CapabilityDescriptor[];
  baseRequest: HostAgentExecutionRequest;
}

export interface RoutedExecutionResult {
  route: ExecutionRoute;
  result: ExecutionResult;
  approvalRef?: string;
}

export interface ExecutionAuditObserver {
  approvalRequested?(payload: { id: string; missionId: string; workItemId: string; executionId: string; scope: "once"; capabilityId?: string; route: ExecutionRouteKind }): Promise<void> | void;
  approvalDecided?(payload: { id: string; missionId: string; workItemId: string; executionId: string; approved: boolean; scope?: "once" | "mission" | "revision" | "host" }): Promise<void> | void;
}

export class WorkExecutionRouter {
  private readonly host: HostAdapter;
  private readonly agents: HostAgentExecutionBackend;
  private readonly hostCapabilities: HostCapabilityExecutionBackend;
  private readonly local: LocalExecutionBackend;
  private readonly resources: ResourceManager;
  private readonly artifactLeases: ArtifactLeaseManager;
  private readonly audit?: ExecutionAuditObserver;

  constructor(input: {
    host: HostAdapter;
    agents: HostAgentExecutionBackend;
    hostCapabilities: HostCapabilityExecutionBackend;
    local: LocalExecutionBackend;
    resources?: ResourceManager;
    artifactLeases?: ArtifactLeaseManager;
    audit?: ExecutionAuditObserver;
  }) {
    this.host = input.host;
    this.agents = input.agents;
    this.hostCapabilities = input.hostCapabilities;
    this.local = input.local;
    this.resources = input.resources ?? new ResourceManager();
    this.artifactLeases = input.artifactLeases ?? new ArtifactLeaseManager();
    this.audit = input.audit;
  }

  select(work: WorkItem, capabilities: CapabilityDescriptor[]): ExecutionRoute {
    const single = capabilities.length === 1 ? capabilities[0] : undefined;
    if (single && single.hostNative && ["tool", "mcp"].includes(single.kind) && single.metadata?.executionMode !== "agent-assisted") {
      return routeFor("host_capability", single, `Single host-native ${single.kind} can directly satisfy the work`);
    }
    if (single && single.hostNative && single.kind === "workflow" && single.metadata?.executionMode === "direct") {
      return routeFor("host_capability", single, "Host workflow explicitly declares direct execution");
    }
    if (single && !single.hostNative && single.kind === "cli" && single.invocationRef && single.metadata?.directProtocol === "worker-envelope-stdio") {
      return routeFor("local_cli", single, "Mission-local CLI declares the worker-envelope stdio protocol");
    }
    return routeFor("host_agent", undefined, capabilities.length > 1
      ? "Multiple capabilities require agent composition"
      : single ? `${single.kind} capability requires agent-assisted execution` : "No direct capability route is available");
  }

  async execute(input: RoutedExecutionInput): Promise<RoutedExecutionResult> {
    const route = input.route ?? this.select(input.work, input.capabilities);
    const ownerId = input.baseRequest.executionId;
    const resourceLease = await this.resources.acquire(ownerId, route.resourceRequest.exclusiveResources ?? []);
    const artifactLease = await this.artifactLeases.acquireWrite(ownerId, input.work.expectedOutputs.map(output => output.logicalName));
    let approvalRef: string | undefined;
    try {
      if (route.requiresApproval) {
        approvalRef = `approval-execution-${input.baseRequest.executionId}`;
        await this.audit?.approvalRequested?.({
          id: approvalRef, missionId: input.work.missionId, workItemId: input.work.id, executionId: input.baseRequest.executionId, scope: "once", capabilityId: route.capability?.id, route: route.kind
        });
        const approval = await this.host.requestUserApproval({
          missionId: input.work.missionId,
          title: `Allow ${route.capability?.name ?? route.kind}`,
          reason: `Execution may perform ${String(route.capability?.metadata?.sideEffectClass ?? "external")} side effects`,
          details: { approvalId: approvalRef, workItemId: input.work.id, capabilityId: route.capability?.id, route: route.kind }
        });
        await this.audit?.approvalDecided?.({
          id: approvalRef, missionId: input.work.missionId, workItemId: input.work.id, executionId: input.baseRequest.executionId, approved: approval.approved, scope: approval.scope
        });
        if (!approval.approved) throw new Error(`Execution approval denied for ${route.capability?.id ?? route.kind}`);
        route.sideEffectPolicy = approvedPolicy(route.sideEffectPolicy);
      }
      const result = route.kind === "host_capability"
        ? await this.executeHostCapability(input, route)
        : route.kind === "local_cli"
          ? await this.executeLocalCli(input, route)
          : await this.executeAgent(input);
      return { route, result, approvalRef };
    } finally {
      artifactLease.release();
      resourceLease.release();
    }
  }

  private async executeAgent(input: RoutedExecutionInput): Promise<ExecutionResult> {
    const handle = await this.agents.allocate(input.baseRequest);
    await this.agents.start(handle);
    return this.agents.collect(handle);
  }

  private async executeHostCapability(input: RoutedExecutionInput, route: ExecutionRoute): Promise<ExecutionResult> {
    const capability = route.capability!;
    const request: HostCapabilityExecutionRequest = {
      ...input.baseRequest,
      executor: { id: capability.id, type: "host_capability" },
      sideEffectPolicy: route.sideEffectPolicy,
      resourceRequest: route.resourceRequest,
      invocation: {
        missionId: input.work.missionId,
        workItemId: input.work.id,
        capabilityId: capability.id,
        invocationRef: capability.invocationRef,
        workspaceRoot: input.baseRequest.workspaceRoot,
        idempotencyKey: `${input.work.missionId}:${input.work.id}:${input.baseRequest.attemptId}`,
        input: input.baseRequest.context
      }
    };
    const handle = await this.hostCapabilities.allocate(request);
    await this.hostCapabilities.start(handle);
    return this.hostCapabilities.collect(handle);
  }

  private async executeLocalCli(input: RoutedExecutionInput, route: ExecutionRoute): Promise<ExecutionResult> {
    const capability = route.capability!;
    const invocationRef = capability.invocationRef!;
    const inputPath = join(input.baseRequest.workspaceRoot ?? process.cwd(), "mission-input.json");
    writeFileSync(inputPath, JSON.stringify(input.baseRequest.context, null, 2), "utf8");
    const template = Array.isArray(capability.metadata?.argsTemplate) ? capability.metadata.argsTemplate.filter((value): value is string => typeof value === "string") : ["{input}"];
    const args = template.map(value => value.replaceAll("{input}", inputPath).replaceAll("{workspace}", input.baseRequest.workspaceRoot ?? process.cwd()));
    const isNodeScript = /\.(?:cjs|mjs|js|ts)$/.test(invocationRef);
    const request: LocalCommandExecutionRequest = {
      ...input.baseRequest,
      executor: { id: capability.id, type: "local_cli" },
      sideEffectPolicy: route.sideEffectPolicy,
      resourceRequest: route.resourceRequest,
      localCommand: isNodeScript ? { command: process.execPath, args: [invocationRef, ...args] } : { command: invocationRef, args },
      outputFiles: []
    };
    const handle = await this.local.allocate(request);
    await this.local.start(handle);
    return this.local.collect(handle);
  }
}

function routeFor(kind: ExecutionRouteKind, capability: CapabilityDescriptor | undefined, reason: string): ExecutionRoute {
  const sideEffectClass = capability?.metadata?.sideEffectClass;
  const requiresApproval = sideEffectClass === "reversible-write" || sideEffectClass === "irreversible-write";
  const exclusiveResources = Array.isArray(capability?.metadata?.exclusiveResources)
    ? capability!.metadata!.exclusiveResources.filter((value): value is string => typeof value === "string") : [];
  return {
    kind,
    capability,
    reason,
    requiresApproval,
    resourceRequest: { exclusiveResources },
    sideEffectPolicy: {
      externalWrites: "deny",
      destructiveWrites: "deny",
      irreversibleActions: "deny",
      idempotencyRequired: true
    }
  };
}

function approvedPolicy(policy: SideEffectPolicy): SideEffectPolicy {
  return { ...policy, externalWrites: "allow", destructiveWrites: "allow", irreversibleActions: "allow" };
}
