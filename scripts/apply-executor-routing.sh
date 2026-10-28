#!/usr/bin/env bash
set -euo pipefail

mkdir -p src/execution/resources src/execution/artifacts src/execution/host src/runtime/orchestration tests/unit tests/integration

cat > src/execution/resources/resource-manager.ts <<'EOF'
export interface ResourceLease {
  ownerId: string;
  resources: string[];
  release(): void;
}

export class ResourceManager {
  private readonly holders = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquire(ownerId: string, resources: string[]): Promise<ResourceLease> {
    const requested = [...new Set(resources)].sort();
    if (requested.length === 0) return { ownerId, resources: [], release() {} };
    while (!this.canAcquire(ownerId, requested)) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    for (const resource of requested) this.holders.set(resource, ownerId);
    let released = false;
    return {
      ownerId,
      resources: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const resource of requested) {
          if (this.holders.get(resource) === ownerId) this.holders.delete(resource);
        }
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    };
  }

  private canAcquire(ownerId: string, resources: string[]): boolean {
    return resources.every(resource => !this.holders.has(resource) || this.holders.get(resource) === ownerId);
  }
}
EOF

cat > src/execution/artifacts/artifact-lease-manager.ts <<'EOF'
export interface ArtifactWriteLease {
  ownerId: string;
  logicalNames: string[];
  release(): void;
}

export class ArtifactLeaseManager {
  private readonly writers = new Map<string, string>();
  private waiters: Array<() => void> = [];

  async acquireWrite(ownerId: string, logicalNames: string[]): Promise<ArtifactWriteLease> {
    const requested = [...new Set(logicalNames.filter(Boolean))].sort();
    if (requested.length === 0) return { ownerId, logicalNames: [], release() {} };
    while (!requested.every(name => !this.writers.has(name) || this.writers.get(name) === ownerId)) {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    for (const name of requested) this.writers.set(name, ownerId);
    let released = false;
    return {
      ownerId,
      logicalNames: requested,
      release: () => {
        if (released) return;
        released = true;
        for (const name of requested) if (this.writers.get(name) === ownerId) this.writers.delete(name);
        const waiters = this.waiters.splice(0);
        for (const waiter of waiters) waiter();
      }
    };
  }
}
EOF

cat > src/execution/host/host-capability-execution-backend.ts <<'EOF'
import type { ExecutionRequest, ExecutionResult, SideEffectRecord } from "../../core/domain/execution.ts";
import type { HostAdapter, HostCapabilityInvocation } from "../../hosts/deepseek/host-adapter.ts";

export interface HostCapabilityExecutionRequest extends ExecutionRequest {
  invocation: HostCapabilityInvocation;
}

export interface HostCapabilityExecutionHandle {
  id: string;
  request: HostCapabilityExecutionRequest;
}

export class HostCapabilityExecutionBackend {
  private readonly host: HostAdapter;
  private readonly active = new Map<string, Promise<ExecutionResult>>();

  constructor(host: HostAdapter) { this.host = host; }

  async allocate(request: HostCapabilityExecutionRequest): Promise<HostCapabilityExecutionHandle> {
    if (request.executor.type !== "host_capability") throw new Error("HostCapabilityExecutionBackend requires executor.type=host_capability");
    return { id: request.executionId, request };
  }

  async start(handle: HostCapabilityExecutionHandle): Promise<void> {
    if (this.active.has(handle.id)) throw new Error(`Execution already active: ${handle.id}`);
    this.active.set(handle.id, this.run(handle));
  }

  async collect(handle: HostCapabilityExecutionHandle): Promise<ExecutionResult> {
    const promise = this.active.get(handle.id);
    if (!promise) throw new Error(`Execution not started: ${handle.id}`);
    const result = await promise;
    this.active.delete(handle.id);
    return result;
  }

  async cancel(_handle: HostCapabilityExecutionHandle): Promise<void> {}

  async recover(executionId: string): Promise<"running" | "lost"> {
    return this.active.has(executionId) ? "running" : "lost";
  }

  private async run(handle: HostCapabilityExecutionHandle): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();
    const response = await this.host.invokeHostCapability(handle.request.invocation);
    const sideEffects = response.sideEffects ?? [];
    const violation = sideEffectViolation(sideEffects, handle.request.sideEffectPolicy);
    const ok = response.ok && !violation;
    return {
      executionId: handle.id,
      state: ok ? "succeeded" : "failed",
      producedFiles: [],
      committedArtifactRefs: [],
      runtimeObservationRef: response.output === undefined ? undefined : JSON.stringify(response.output),
      sideEffects,
      logRef: violation ?? response.error,
      startedAt,
      endedAt: new Date().toISOString()
    };
  }
}

function sideEffectViolation(effects: SideEffectRecord[], policy: ExecutionRequest["sideEffectPolicy"]): string | undefined {
  for (const effect of effects) {
    if (["external-write", "message"].includes(effect.type) && policy.externalWrites !== "allow") return `External write side effect is not allowed: ${effect.type}:${effect.target}`;
    if (["deployment", "system-change"].includes(effect.type) && policy.destructiveWrites !== "allow") return `Destructive side effect is not allowed: ${effect.type}:${effect.target}`;
    if (!effect.reversible && policy.irreversibleActions !== "allow") return `Irreversible side effect is not allowed: ${effect.type}:${effect.target}`;
  }
  return undefined;
}
EOF

cat > src/runtime/orchestration/executor-router.ts <<'EOF'
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
  capabilities: CapabilityDescriptor[];
  baseRequest: HostAgentExecutionRequest;
}

export interface RoutedExecutionResult {
  route: ExecutionRoute;
  result: ExecutionResult;
}

export class WorkExecutionRouter {
  private readonly host: HostAdapter;
  private readonly agents: HostAgentExecutionBackend;
  private readonly hostCapabilities: HostCapabilityExecutionBackend;
  private readonly local: LocalExecutionBackend;
  private readonly resources: ResourceManager;
  private readonly artifactLeases: ArtifactLeaseManager;

  constructor(input: {
    host: HostAdapter;
    agents: HostAgentExecutionBackend;
    hostCapabilities: HostCapabilityExecutionBackend;
    local: LocalExecutionBackend;
    resources?: ResourceManager;
    artifactLeases?: ArtifactLeaseManager;
  }) {
    this.host = input.host;
    this.agents = input.agents;
    this.hostCapabilities = input.hostCapabilities;
    this.local = input.local;
    this.resources = input.resources ?? new ResourceManager();
    this.artifactLeases = input.artifactLeases ?? new ArtifactLeaseManager();
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
    const route = this.select(input.work, input.capabilities);
    const ownerId = input.baseRequest.executionId;
    const resourceLease = await this.resources.acquire(ownerId, route.resourceRequest.exclusiveResources ?? []);
    const artifactLease = await this.artifactLeases.acquireWrite(ownerId, input.work.expectedOutputs.map(output => output.logicalName));
    try {
      if (route.requiresApproval) {
        const approval = await this.host.requestUserApproval({
          missionId: input.work.missionId,
          title: `Allow ${route.capability?.name ?? route.kind}`,
          reason: `Execution may perform ${String(route.capability?.metadata?.sideEffectClass ?? "external")} side effects`,
          details: { workItemId: input.work.id, capabilityId: route.capability?.id, route: route.kind }
        });
        if (!approval.approved) throw new Error(`Execution approval denied for ${route.capability?.id ?? route.kind}`);
        route.sideEffectPolicy = approvedPolicy(route.sideEffectPolicy);
      }
      if (route.kind === "host_capability") return { route, result: await this.executeHostCapability(input, route) };
      if (route.kind === "local_cli") return { route, result: await this.executeLocalCli(input, route) };
      return { route, result: await this.executeAgent(input) };
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
EOF

python - <<'PY'
from pathlib import Path

p=Path('src/core/domain/execution.ts')
s=p.read_text()
s=s.replace('destructiveWrites: "deny" | "approval";\n  irreversibleActions: "deny" | "approval";', 'destructiveWrites: "deny" | "approval" | "allow";\n  irreversibleActions: "deny" | "approval" | "allow";')
s=s.replace('type: "host_agent" | "workflow" | "cli" | "tool" | "verifier";', 'type: "host_agent" | "host_capability" | "local_cli" | "workflow" | "cli" | "tool" | "verifier";')
p.write_text(s)

p=Path('src/hosts/deepseek/host-adapter.ts')
s=p.read_text()
s=s.replace('import type { CapabilityDescriptor } from "../../core/domain/capability.ts";','import type { CapabilityDescriptor } from "../../core/domain/capability.ts";\nimport type { SideEffectRecord } from "../../core/domain/execution.ts";')
s=s.replace('export interface HostCapabilityInvocation {\n  capabilityId: string;\n  input: unknown;\n}', 'export interface HostCapabilityInvocation {\n  missionId?: string;\n  workItemId?: string;\n  capabilityId: string;\n  invocationRef?: string;\n  workspaceRoot?: string;\n  idempotencyKey?: string;\n  input: unknown;\n}')
s=s.replace('export interface HostCapabilityResult {\n  ok: boolean;\n  output?: unknown;\n  error?: string;\n}', 'export interface HostCapabilityResult {\n  ok: boolean;\n  output?: unknown;\n  error?: string;\n  sideEffects?: SideEffectRecord[];\n}')
p.write_text(s)

p=Path('src/execution/local/local-execution-backend.ts')
s=p.read_text()
s=s.replace('      logRef: logPath,\n      sideEffects: [],', '      runtimeObservationRef: run.stdout.trim() || undefined,\n      logRef: logPath,\n      sideEffects: [],')
p.write_text(s)

p=Path('src/hosts/fake/fake-host-adapter.ts')
s=p.read_text()
s=s.replace('  private readonly requests = new Map<string, AgentCreateRequest>();', '  private readonly requests = new Map<string, AgentCreateRequest>();\n  readonly agentRequests: AgentCreateRequest[] = [];\n  readonly capabilityInvocations: HostCapabilityInvocation[] = [];')
s=s.replace('  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {\n    const handle = { id: randomUUID() };', '  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {\n    this.agentRequests.push(request);\n    const handle = { id: randomUUID() };')
s=s.replace('  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {\n    return this.options.capabilityInvoker', '  async invokeHostCapability(request: HostCapabilityInvocation): Promise<HostCapabilityResult> {\n    this.capabilityInvocations.push(request);\n    return this.options.capabilityInvoker')
p.write_text(s)

p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()
s=s.replace('import type { Verifier } from "../../core/verification/verifier.ts";', 'import type { Verifier } from "../../core/verification/verifier.ts";\nimport type { WorkExecutionRouter, ExecutionRoute } from "./executor-router.ts";')
s=s.replace('  private readonly capabilityCoordinator?: CapabilityCoordinator;', '  private readonly capabilityCoordinator?: CapabilityCoordinator;\n  private readonly executionRouter?: WorkExecutionRouter;')
s=s.replace('    capabilityCoordinator?: CapabilityCoordinator;\n    options?: MissionOrchestratorOptions;', '    capabilityCoordinator?: CapabilityCoordinator;\n    executionRouter?: WorkExecutionRouter;\n    options?: MissionOrchestratorOptions;')
s=s.replace('    this.capabilityCoordinator = input.capabilityCoordinator;', '    this.capabilityCoordinator = input.capabilityCoordinator;\n    this.executionRouter = input.executionRouter;')
s=s.replace('    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: "host-agent", contextPacketId: contextPacket.id }, { type: "controller" }, `attempt:${attemptId}`);', '    const selectedRoute: ExecutionRoute = this.executionRouter?.select(work, capabilities) ?? { kind: "host_agent", reason: "legacy host-agent route", sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }, resourceRequest: {}, requiresApproval: false };\n    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: selectedRoute.kind, contextPacketId: contextPacket.id }, { type: "controller" }, `attempt:${attemptId}`);')
s=s.replace('    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId }, { type: "controller" }, `execution-created:${executionId}`);', '    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, executorType: selectedRoute.kind, routeReason: selectedRoute.reason }, { type: "controller" }, `execution-created:${executionId}`);')
old='''      const handle = await this.hostBackend.allocate(request);\n      await this.controller.emit(work.missionId, "execution.started", { id: executionId }, { type: "host" }, `execution-started:${executionId}`);\n      await this.hostBackend.start(handle);\n      const result = await this.hostBackend.collect(handle);'''
new='''      await this.controller.emit(work.missionId, "execution.started", { id: executionId, executorType: selectedRoute.kind }, { type: "host" }, `execution-started:${executionId}`);\n      let result;\n      if (this.executionRouter) {\n        const routed = await this.executionRouter.execute({ work, capabilities, baseRequest: request });\n        result = routed.result;\n      } else {\n        const handle = await this.hostBackend.allocate(request);\n        await this.hostBackend.start(handle);\n        result = await this.hostBackend.collect(handle);\n      }'''
if old not in s: raise SystemExit('orchestrator execution block not found')
s=s.replace(old,new)
p.write_text(s)

p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { HostAgentExecutionBackend } from "../execution/host/host-agent-execution-backend.ts";', 'import { HostAgentExecutionBackend } from "../execution/host/host-agent-execution-backend.ts";\nimport { HostCapabilityExecutionBackend } from "../execution/host/host-capability-execution-backend.ts";\nimport { LocalExecutionBackend } from "../execution/local/local-execution-backend.ts";\nimport { WorkExecutionRouter } from "./orchestration/executor-router.ts";')
old='''      this.orchestrator = new MissionOrchestrator({\n        controller: this.controller,\n        projections: this.projections,\n        hostBackend: new HostAgentExecutionBackend(options.host),'''
new='''      const hostAgentBackend = new HostAgentExecutionBackend(options.host);\n      const executionRouter = new WorkExecutionRouter({\n        host: options.host,\n        agents: hostAgentBackend,\n        hostCapabilities: new HostCapabilityExecutionBackend(options.host),\n        local: new LocalExecutionBackend(this.workspaces, this.artifacts)\n      });\n      this.orchestrator = new MissionOrchestrator({\n        controller: this.controller,\n        projections: this.projections,\n        hostBackend: hostAgentBackend,'''
if old not in s: raise SystemExit('mission runtime orchestrator block not found')
s=s.replace(old,new)
s=s.replace('        capabilityCoordinator: new CapabilityCoordinator({ controller: this.controller, projections: this.projections, host: options.host, acquisition: options.acquisition }),\n        options:', '        capabilityCoordinator: new CapabilityCoordinator({ controller: this.controller, projections: this.projections, host: options.host, acquisition: options.acquisition }),\n        executionRouter,\n        options:')
p.write_text(s)
PY

cat > tests/unit/executor-router.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkExecutionRouter } from "../../src/runtime/orchestration/executor-router.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../../src/execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { WorkspaceManager } from "../../src/execution/workspace/workspace-manager.ts";
import { FileArtifactStore } from "../../src/execution/artifacts/artifact-store.ts";
import type { CapabilityDescriptor } from "../../src/core/domain/capability.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function work(): WorkItem {
  const now = new Date().toISOString();
  return { id: "w", missionId: "m", purpose: "production", objective: "render report", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 1, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}
function capability(overrides: Partial<CapabilityDescriptor>): CapabilityDescriptor {
  return { id: "c", kind: "tool", name: "render", description: "render report", hostNative: true, available: true, permissions: [], scope: "host", ...overrides };
}
function router() {
  const root = mkdtempSync(join(tmpdir(), "mission-router-"));
  const host = new FakeHostAdapter();
  const workspaces = new WorkspaceManager(root);
  const artifacts = new FileArtifactStore(root);
  return new WorkExecutionRouter({ host, agents: new HostAgentExecutionBackend(host), hostCapabilities: new HostCapabilityExecutionBackend(host), local: new LocalExecutionBackend(workspaces, artifacts) });
}

test("routes a single host tool directly", () => {
  assert.equal(router().select(work(), [capability({ kind: "tool" })]).kind, "host_capability");
});

test("keeps skills and multi-capability composition on a host agent", () => {
  assert.equal(router().select(work(), [capability({ kind: "skill" })]).kind, "host_agent");
  assert.equal(router().select(work(), [capability({ id: "a" }), capability({ id: "b", kind: "mcp" })]).kind, "host_agent");
});

test("routes an explicitly structured mission-local CLI directly", () => {
  const route = router().select(work(), [capability({ kind: "cli", hostNative: false, invocationRef: "/tmp/tool.js", scope: "mission", metadata: { directProtocol: "worker-envelope-stdio", argsTemplate: ["{input}"] } })]);
  assert.equal(route.kind, "local_cli");
});
EOF

cat > tests/integration/executor-routing.test.ts <<'EOF'
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";

const tool: CapabilityDescriptor = {
  id: "host:report-tool", kind: "tool", name: "report tool", description: "render report document", hostNative: true, available: true,
  invocationRef: "report-tool", permissions: [], scope: "host", metadata: { executionMode: "direct", sideEffectClass: "read" }
};

test("orchestrator directly invokes a resolved host tool instead of spawning an agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-direct-tool-"));
  const host = new FakeHostAdapter([tool], {
    capabilityInvoker: request => {
      assert.equal(request.capabilityId, tool.id);
      assert.ok(request.workspaceRoot);
      writeFileSync(join(request.workspaceRoot!, "report.md"), "# routed directly\n", "utf8");
      return { ok: true, output: { status: "completed", summary: "direct tool complete", outputs: [{ path: "report.md", logicalName: "report", kind: "document" }], proposedFacts: [], proposedWork: [], warnings: [] } };
    }
  });
  const runtime = new MissionRuntime({ rootDir: root, host });
  const missionId = "direct-tool-mission";
  await runtime.controller.createMission(missionId, "render report");
  const need: CapabilityNeed = { id: "need-report", missionId, objective: "render report", requiredFunctions: ["render report"], desiredInputs: [], desiredOutputs: ["document"], purpose: "production", urgency: "blocking", acquisitionAllowed: false, maxRisk: "low", requirementRefs: [], gapRefs: [], status: "checking-installed" };
  await runtime.controller.emit(missionId, "capability.need.created", { need }, { type: "planner" }, `need:${need.id}`);
  const now = new Date().toISOString();
  await runtime.controller.proposeWork({ id: "work-report", missionId, purpose: "production", objective: "render report", status: "ready", requirementRefs: [], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "report", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: [need.id], priority: 10, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now });
  await runtime.orchestrator!.runUntilQuiescent(missionId);
  assert.equal(host.agentRequests.length, 0);
  assert.equal(host.capabilityInvocations.length, 1);
  const artifacts = await runtime.projections.listArtifacts(missionId);
  assert.ok(artifacts.some(artifact => artifact.logicalName === "report"));
  runtime.close();
});
EOF

npm test
npm run smoke
git diff --check
