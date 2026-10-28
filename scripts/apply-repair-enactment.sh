#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s:
        raise SystemExit(f"pattern not found in {path}: {old[:120]!r}")
    p.write_text(s.replace(old,new,1))

# Execution result records the concrete executor that actually ran.
rep('src/core/domain/execution.ts',
'''  state: "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "lost";\n  exitCode?: number;\n  producedFiles: ProducedFile[];''',
'''  state: "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "lost";\n  exitCode?: number;\n  executorRef?: string;\n  producedFiles: ProducedFile[];''')

# Host agent request can carry repair-time executor constraints.
rep('src/hosts/deepseek/host-adapter.ts',
'''  allowedCapabilityRefs: string[];\n  workspaceRoot?: string;\n}''',
'''  allowedCapabilityRefs: string[];\n  workspaceRoot?: string;\n  preferredExecutorRefs?: string[];\n  excludeExecutorRefs?: string[];\n  forceFreshAgent?: boolean;\n}''')

rep('src/execution/host/host-agent-execution-backend.ts',
'''      allowedCapabilityRefs: handle.request.capabilityRefs,\n      workspaceRoot: handle.request.workspaceRoot\n    });''',
'''      allowedCapabilityRefs: handle.request.capabilityRefs,\n      workspaceRoot: handle.request.workspaceRoot,\n      preferredExecutorRefs: handle.request.preferredExecutorRefs,\n      excludeExecutorRefs: handle.request.excludeExecutorRefs,\n      forceFreshAgent: handle.request.forceFreshAgent\n    });''')
rep('src/execution/host/host-agent-execution-backend.ts',
'''      executionId: handle.id,\n      state: this.cancelled.has(handle.id) ? "cancelled" : failure ? "failed" : "succeeded",\n      producedFiles: [],''',
'''      executionId: handle.id,\n      state: this.cancelled.has(handle.id) ? "cancelled" : failure ? "failed" : "succeeded",\n      executorRef: handle.agent.nativeRef ?? handle.agent.id,\n      producedFiles: [],''')

# Read model exposes durable invocation/capability history to the repair planner.
rep('src/core/mission/mission-read-model.ts',
'''import type { Artifact } from "../domain/artifact.ts";''',
'''import type { Artifact } from "../domain/artifact.ts";\nimport type { CapabilityNeed } from "../domain/capability.ts";\nimport type { InvocationReceipt } from "../domain/invocation.ts";''')
rep('src/core/mission/mission-read-model.ts',
'''  async verifications(missionId: string): Promise<VerificationResult[]> {''',
'''  async invocationReceipts(missionId: string): Promise<InvocationReceipt[]> {\n    if (this.projections) return this.projections.listInvocationReceipts(missionId);\n    return (await this.store.list(missionId))\n      .filter(event => event.type === "execution.invocation.recorded")\n      .map(event => (((event.payload as any).receipt ?? event.payload) as InvocationReceipt));\n  }\n\n  async capabilityNeeds(missionId: string): Promise<CapabilityNeed[]> {\n    if (this.projections) return this.projections.listCapabilityNeeds(missionId);\n    const needs = new Map<string, CapabilityNeed>();\n    for (const event of await this.store.list(missionId)) {\n      const payload = event.payload as any;\n      if (event.type === "capability.need.created") {\n        const need = (payload.need ?? payload) as CapabilityNeed;\n        needs.set(need.id, { ...need, missionId, status: need.status ?? "checking-installed" });\n      }\n      if (event.type === "capability.need.updated" && payload.id && needs.has(payload.id)) {\n        Object.assign(needs.get(payload.id)!, { status: payload.status, resolvedCapabilityRef: payload.resolvedCapabilityRef });\n      }\n    }\n    return [...needs.values()];\n  }\n\n  async verifications(missionId: string): Promise<VerificationResult[]> {''')

# Persist capability invalidation as a real unavailable descriptor.
rep('src/persistence/sqlite/sqlite-entity-projector.ts',
'''      case "capability.activated": {''',
'''      case "capability.invalidated": {\n        const capabilityId = payload.id ?? payload.capabilityRef;\n        if (!capabilityId) return;\n        const row = db.prepare("SELECT data_json FROM capabilities WHERE id = ? AND mission_id = ?").get(capabilityId, event.missionId) as { data_json: string } | undefined;\n        if (!row) return;\n        const capability = JSON.parse(row.data_json) as CapabilityDescriptor;\n        capability.available = false;\n        capability.metadata = { ...(capability.metadata ?? {}), invalidatedAt: event.createdAt, invalidationReason: payload.reason };\n        db.prepare("UPDATE capabilities SET status = 'unavailable', data_json = ? WHERE id = ? AND mission_id = ?")\n          .run(JSON.stringify(capability), capabilityId, event.missionId);\n        return;\n      }\n      case "capability.activated": {''')

# Coordinator never resolves a capability explicitly excluded by a repair decision.
rep('src/runtime/orchestration/capability-coordinator.ts',
'''    const effective = mergeCapabilities(environment.capabilities, missionCapabilities);\n    const requested = work.capabilityNeedRefs.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);''',
'''    const excludedCapabilityRefs = new Set(work.executionConstraints?.excludeCapabilityRefs ?? []);\n    const effective = mergeCapabilities(environment.capabilities, missionCapabilities)\n      .filter(capability => !excludedCapabilityRefs.has(capability.id));\n    const requestedIds = [...new Set([\n      ...work.capabilityNeedRefs,\n      ...(work.executionConstraints?.preferredCapabilityNeedRefs ?? [])\n    ])];\n    const requested = requestedIds.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);''')
rep('src/runtime/orchestration/capability-coordinator.ts',
'''      const resolvedByRef = need.resolvedCapabilityRef ? effective.find(cap => cap.id === need.resolvedCapabilityRef && cap.available) : undefined;''',
'''      const resolvedByRef = need.resolvedCapabilityRef && !excludedCapabilityRefs.has(need.resolvedCapabilityRef)\n        ? effective.find(cap => cap.id === need.resolvedCapabilityRef && cap.available)\n        : undefined;''')

# Router treats route avoidance as a preference: use a materially different route when one exists,
# but never deadlock a mission if the only safe route is a fresh host agent.
rep('src/runtime/orchestration/executor-router.ts',
'''  select(work: WorkItem, capabilities: CapabilityDescriptor[]): ExecutionRoute {\n    const single = capabilities.length === 1 ? capabilities[0] : undefined;\n    if (single && single.hostNative && ["tool", "mcp"].includes(single.kind) && single.metadata?.executionMode !== "agent-assisted") {\n      return routeFor("host_capability", single, `Single host-native ${single.kind} can directly satisfy the work`);\n    }\n    if (single && single.hostNative && single.kind === "workflow" && single.metadata?.executionMode === "direct") {\n      return routeFor("host_capability", single, "Host workflow explicitly declares direct execution");\n    }\n    if (single && !single.hostNative && single.kind === "cli" && single.invocationRef && single.metadata?.directProtocol === "worker-envelope-stdio") {\n      return routeFor("local_cli", single, "Mission-local CLI declares the worker-envelope stdio protocol");\n    }\n    return routeFor("host_agent", undefined, capabilities.length > 1\n      ? "Multiple capabilities require agent composition"\n      : single ? `${single.kind} capability requires agent-assisted execution` : "No direct capability route is available");\n  }''',
'''  select(work: WorkItem, capabilities: CapabilityDescriptor[]): ExecutionRoute {\n    const excluded = new Set(work.executionConstraints?.excludeCapabilityRefs ?? []);\n    const usable = capabilities.filter(capability => !excluded.has(capability.id));\n    const single = usable.length === 1 ? usable[0] : undefined;\n    const alternatives: ExecutionRoute[] = [];\n    if (single && single.hostNative && ["tool", "mcp"].includes(single.kind) && single.metadata?.executionMode !== "agent-assisted") {\n      alternatives.push(routeFor("host_capability", single, `Single host-native ${single.kind} can directly satisfy the work`));\n    }\n    if (single && single.hostNative && single.kind === "workflow" && single.metadata?.executionMode === "direct") {\n      alternatives.push(routeFor("host_capability", single, "Host workflow explicitly declares direct execution"));\n    }\n    if (single && !single.hostNative && single.kind === "cli" && single.invocationRef && single.metadata?.directProtocol === "worker-envelope-stdio") {\n      alternatives.push(routeFor("local_cli", single, "Mission-local CLI declares the worker-envelope stdio protocol"));\n    }\n    alternatives.push(routeFor("host_agent", single?.kind === "agent" ? single : undefined, usable.length > 1\n      ? "Multiple capabilities require agent composition"\n      : single ? `${single.kind} capability requires agent-assisted execution` : "No direct capability route is available"));\n    const avoided = new Set(work.executionConstraints?.avoidRouteKinds ?? []);\n    return alternatives.find(route => !avoided.has(route.kind)) ?? alternatives[alternatives.length - 1]!;\n  }''')

# Orchestrator sends executor constraints to the host and records the actual executor identity.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''      sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true }\n    };''',
'''      sideEffectPolicy: { externalWrites: "approval", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: true },\n      preferredExecutorRefs: work.assignedExecutorId ? [work.assignedExecutorId] : undefined,\n      excludeExecutorRefs: work.executionConstraints?.excludeExecutorRefs,\n      forceFreshAgent: work.executionConstraints?.forceFreshAgent\n    };''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''        targetRef: selectedRoute.capability?.id, approvalRef, result: result.state, sideEffects: result.sideEffects, envelope,''',
'''        targetRef: result.executorRef ?? selectedRoute.capability?.id, approvalRef, result: result.state, sideEffects: result.sideEffects, envelope,''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),\n        targetRef: selectedRoute.capability?.id, idempotencyKey:''',
'''        route: selectedRoute.kind, routeReason: selectedRoute.reason, capabilityRefs: capabilities.map(capability => capability.id),\n        targetRef: result.executorRef ?? selectedRoute.capability?.id, idempotencyKey:''')

# Controller applies the diagnosis instead of only describing it.
rep('src/core/mission/controller.ts',
'''import { normalizeGapDiagnosis } from "../planning/repair-scope-policy.ts";''',
'''import { normalizeGapDiagnosis } from "../planning/repair-scope-policy.ts";\nimport { RepairEnactmentPolicy } from "../planning/repair-enactment-policy.ts";''')
rep('src/core/mission/controller.ts',
'''  private readonly readModel: MissionReadModel;''',
'''  private readonly readModel: MissionReadModel;\n  private readonly repairEnactment = new RepairEnactmentPolicy();''')
rep('src/core/mission/controller.ts',
'''        } else {\n          const repair = this.repairWorkItem(state, blockingGap, diagnosis, priorRepairCount + 1);\n          await this.proposeWork(repair);\n          workItemsCreated.push(repair.id);\n        }\n        state = await this.state(input.missionId);''',
'''        } else {\n          const relatedWorkIds = new Set(relatedWorkItems.map(work => work.id));\n          const [invocationReceipts, capabilityNeeds] = await Promise.all([\n            this.readModel.invocationReceipts(input.missionId),\n            this.readModel.capabilityNeeds(input.missionId)\n          ]);\n          const enactment = this.repairEnactment.plan({\n            missionId: input.missionId,\n            gap: blockingGap,\n            diagnosis,\n            invocationReceipts: invocationReceipts.filter(receipt => relatedWorkIds.has(receipt.workItemId)),\n            capabilityNeeds,\n            repairSequence: priorRepairCount + 1\n          });\n          if (enactment.failedCapabilityRef) {\n            await this.emit(input.missionId, "capability.invalidated", {\n              id: enactment.failedCapabilityRef,\n              reason: diagnosis.rootCause,\n              gapId: blockingGap.id,\n              decisionId: decision.id\n            }, { type: "controller" }, `capability-invalidated:${blockingGap.id}:${enactment.failedCapabilityRef}`);\n          }\n          if (enactment.replacementNeed) {\n            await this.emit(input.missionId, "capability.need.created", { need: enactment.replacementNeed }, { type: "controller" }, `capability-need:${enactment.replacementNeed.id}`);\n          }\n          const repair = this.repairWorkItem(\n            state,\n            blockingGap,\n            diagnosis,\n            priorRepairCount + 1,\n            enactment.executionConstraints,\n            enactment.replacementNeed?.id\n          );\n          await this.proposeWork(repair);\n          workItemsCreated.push(repair.id);\n        }\n        await this.emit(input.missionId, "decision.applied", { id: decision.id }, { type: "controller" }, `decision-applied:${decision.id}`);\n        state = await this.state(input.missionId);''')
rep('src/core/mission/controller.ts',
'''  private repairWorkItem(state: MissionState, gap: Gap, diagnosis: GapDiagnosis, sequence: number): WorkItem {''',
'''  private repairWorkItem(\n    state: MissionState,\n    gap: Gap,\n    diagnosis: GapDiagnosis,\n    sequence: number,\n    executionConstraints?: import("../domain/work-item.ts").WorkExecutionConstraints,\n    replacementNeedRef?: string\n  ): WorkItem {''')
rep('src/core/mission/controller.ts',
'''      capabilityNeedRefs: [],\n      priority:''',
'''      capabilityNeedRefs: replacementNeedRef ? [replacementNeedRef] : [],\n      executionConstraints,\n      priority:''')
PY

cat > tests/integration/repair-enactment.test.ts <<'TS'
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { WorkExecutionRouter } from "../../src/runtime/orchestration/executor-router.ts";
import { HostAgentExecutionBackend } from "../../src/execution/host/host-agent-execution-backend.ts";
import { HostCapabilityExecutionBackend } from "../../src/execution/host/host-capability-execution-backend.ts";
import { LocalExecutionBackend } from "../../src/execution/local/local-execution-backend.ts";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup(intervention: "replace_capability" | "replace_executor") {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const deliberation: DeliberationProvider = {
    async composeStrategy() { return { framing: "repair", approach: "repair", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) {
      return { gapId: gap.id, rootCause: "the selected execution path repeatedly fails semantically", intervention, confidence: 0.93, repairScope: intervention === "replace_capability" ? "capability" : "executor" };
    },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  return { db, projections, events, controller: new MissionController(events, { projections, deliberation }) };
}

async function seedBrokenWork(controller: MissionController, missionId: string) {
  await controller.createMission(missionId, "repair the failed artifact");
  const now = new Date().toISOString();
  const work: WorkItem = {
    id: "w-broken", missionId, purpose: "production", objective: "produce artifact", status: "failed",
    requirementRefs: ["r1"], gapRefs: ["g1"], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: ["need-old"],
    priority: 80, graphRevision: 0, createdBy: "planner", createdAt: now, updatedAt: now
  };
  await controller.proposeWork(work);
  await controller.emit(missionId, "capability.need.created", { need: {
    id: "need-old", missionId, objective: "render artifact", requiredFunctions: ["render artifact"], desiredInputs: [], desiredOutputs: [],
    purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: ["r1"], gapRefs: ["g1"],
    status: "available", resolvedCapabilityRef: "cap-old"
  } }, { type: "planner" });
  await controller.emit(missionId, "capability.activated", { needId: "need-old", capability: {
    id: "cap-old", kind: "tool", name: "Old Renderer", description: "render artifact", hostNative: true, available: true,
    invocationRef: "old.render", permissions: [], scope: "mission"
  } }, { type: "system" });
  await controller.emit(missionId, "execution.invocation.recorded", { receipt: {
    id: "inv-old", missionId, workItemId: "w-broken", attemptId: "a-old", executionId: "e-old", route: "host_capability",
    routeReason: "old route", capabilityRefs: ["cap-old"], targetRef: "cap-old", sideEffects: [], result: "failed",
    startedAt: now, endedAt: now, createdAt: now
  } }, { type: "system" });
  await controller.openGap(missionId, { id: "g1", severity: "major", description: "renderer output is invalid", requirementRefs: ["r1"] });
}

test("replace_capability invalidates the old capability and creates a replacement need wired to repair work", async () => {
  const { db, controller, projections } = setup("replace_capability");
  await seedBrokenWork(controller, "m-cap-replace");
  const cycle = await controller.runControllerCycle({ missionId: "m-cap-replace", trigger: "verification_event" });
  assert.deepEqual(cycle.workItemsCreated, ["repair-g1"]);
  const old = (await projections.listCapabilities("m-cap-replace")).find(cap => cap.id === "cap-old");
  assert.equal(old?.available, false);
  const replacement = (await projections.listCapabilityNeeds("m-cap-replace")).find(need => need.replacesCapabilityRef === "cap-old");
  assert.ok(replacement);
  const repair = (await projections.listWorkItems("m-cap-replace")).find(work => work.id === "repair-g1");
  assert.deepEqual(repair?.capabilityNeedRefs, [replacement!.id]);
  assert.deepEqual(repair?.executionConstraints?.excludeCapabilityRefs, ["cap-old"]);
  const events = await (controller as any).store.list("m-cap-replace");
  assert.ok(events.some((event: any) => event.type === "decision.applied"));
  db.close();
});

test("replace_executor makes the next repair prefer a different route when one is available", async () => {
  const { db, controller, projections } = setup("replace_executor");
  await seedBrokenWork(controller, "m-executor-replace");
  await controller.runControllerCycle({ missionId: "m-executor-replace", trigger: "verification_event" });
  const repair = (await projections.listWorkItems("m-executor-replace")).find(work => work.id === "repair-g1")!;
  assert.equal(repair.executionConstraints?.forceFreshAgent, true);
  assert.deepEqual(repair.executionConstraints?.avoidRouteKinds, ["host_capability"]);
  const host = new FakeHostAdapter();
  const router = new WorkExecutionRouter({
    host,
    agents: new HostAgentExecutionBackend(host),
    hostCapabilities: new HostCapabilityExecutionBackend(host),
    local: new LocalExecutionBackend(new ProcessManager())
  });
  const route = router.select(repair, [{
    id: "cap-new", kind: "tool", name: "New Renderer", description: "render artifact", hostNative: true, available: true,
    invocationRef: "new.render", permissions: [], scope: "mission"
  }]);
  assert.equal(route.kind, "host_agent");
  db.close();
});
TS
