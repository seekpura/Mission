#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def rep(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s: raise SystemExit(f'pattern not found in {path}: {old[:100]!r}')
    p.write_text(s.replace(old,new,1))

# Deliberation contract can classify steering without forcing every provider to implement it.
rep('src/core/planning/deliberation-provider.ts',
'''import type { Evidence, Finding, Gap } from "../domain/verification.ts";''',
'''import type { Evidence, Finding, Gap } from "../domain/verification.ts";\nimport type { Artifact } from "../domain/artifact.ts";\nimport type { SteeringInterpretation } from "../domain/steering.ts";''')
rep('src/core/planning/deliberation-provider.ts',
'''  interpretMission?(input: { missionId: string; userGoal: string; state: MissionState }): Promise<MissionInterpretation>;''',
'''  interpretMission?(input: { missionId: string; userGoal: string; state: MissionState }): Promise<MissionInterpretation>;\n  interpretSteering?(input: {\n    missionId: string;\n    message: string;\n    state: MissionState;\n    missionSpec: MissionSpec | null;\n    acceptanceContract: AcceptanceContract | null;\n    workItems: WorkItem[];\n    artifacts: Artifact[];\n  }): Promise<SteeringInterpretation>;''')

# Host deliberation gets a structured steering classifier/impact composer.
rep('src/core/planning/host-deliberation-provider.ts',
'''import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge, MissionInterpretation } from "./deliberation-provider.ts";''',
'''import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge, MissionInterpretation } from "./deliberation-provider.ts";\nimport type { SteeringInterpretation } from "../domain/steering.ts";''')
marker='''  async composeStrategy(input: Parameters<DeliberationProvider["composeStrategy"]>[0]): Promise<StrategyProposal> {'''
method='''  async interpretSteering(input: Parameters<NonNullable<DeliberationProvider["interpretSteering"]>>[0]): Promise<SteeringInterpretation> {\n    const value = await this.askJson(input.missionId, "steering", `\nYou are the Mission Runtime Steering Interpreter.\nUser steering: ${input.message}\nCurrent MissionSpec: ${JSON.stringify(input.missionSpec)}\nCurrent AcceptanceContract: ${JSON.stringify(input.acceptanceContract)}\nCurrent work: ${JSON.stringify(input.workItems.map(work => ({ id: work.id, status: work.status, purpose: work.purpose, objective: work.objective, requirementRefs: work.requirementRefs, inputArtifactRefs: work.inputArtifactRefs, expectedOutputs: work.expectedOutputs })))}\nCurrent artifacts: ${JSON.stringify(input.artifacts.map(artifact => ({ ref: `${artifact.id}@${artifact.version}`, logicalName: artifact.logicalName, status: artifact.status, sourceArtifactRefs: artifact.sourceArtifactRefs })))}\nClassify pure operational messages such as "continue", "resume", or simple sequencing as kind=operational. They must not rewrite the mission.\nFor semantic changes, return only the smallest scope affected. Do not invalidate unrelated work. If the user changes required deliverables or completion criteria, return a complete revisedAcceptanceContract; otherwise omit it.\nReturn ONLY JSON: {\n  "kind":"operational|semantic",\n  "reason":string,\n  "confidence":number,\n  "specPatch":{"objective"?:string,"intent"?:string,"requestedOutputs"?:string[],"constraints"?:string[],"preferences"?:string[],"sourceRefs"?:string[]} | null,\n  "revisedAcceptanceContract":{"requirements":[{"id":string,"description":string,"type":"functional|content|visual|technical|evidence|experience|compliance","priority":"critical|required|preferred","verification":"artifact|test|review|evidence|runtime|human"}],"requiredArtifacts":[{"logicalName":string,"type":string,"description":string,"requirementRefs":string[]}],"requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[]}],"criticalFailureConditions":string[]} | null,\n  "affectedRequirementRefs":string[],\n  "affectedWorkItemRefs":string[],\n  "affectedArtifactRefs":string[],\n  "strategyImpact":"none|local|global"\n}.\n`);\n    const kind = value.kind === "semantic" ? "semantic" as const : "operational" as const;\n    const rawPatch = value.specPatch && typeof value.specPatch === "object" ? value.specPatch : undefined;\n    const specPatch = rawPatch ? {\n      objective: typeof rawPatch.objective === "string" ? rawPatch.objective : undefined,\n      intent: typeof rawPatch.intent === "string" ? rawPatch.intent : undefined,\n      requestedOutputs: Array.isArray(rawPatch.requestedOutputs) ? stringArray(rawPatch.requestedOutputs) : undefined,\n      constraints: Array.isArray(rawPatch.constraints) ? stringArray(rawPatch.constraints) : undefined,\n      preferences: Array.isArray(rawPatch.preferences) ? stringArray(rawPatch.preferences) : undefined,\n      sourceRefs: Array.isArray(rawPatch.sourceRefs) ? stringArray(rawPatch.sourceRefs) : undefined\n    } : undefined;\n    const rawContract = value.revisedAcceptanceContract;\n    const revisedAcceptanceContract = rawContract && typeof rawContract === "object" ? {\n      requirements: arrayValue(rawContract.requirements).map((raw: any, index) => ({\n        id: stringValue(raw?.id, `steer-R${index + 1}`), description: stringValue(raw?.description, `Steered requirement ${index + 1}`),\n        type: requirementType(raw?.type), priority: requirementPriority(raw?.priority), verification: requirementVerification(raw?.verification),\n        status: "unverified" as const, evidenceRefs: []\n      })),\n      requiredArtifacts: arrayValue(rawContract.requiredArtifacts).map((raw: any, index) => ({\n        logicalName: stringValue(raw?.logicalName, `deliverable-${index + 1}`), type: typeof raw?.type === "string" ? raw.type : undefined,\n        description: typeof raw?.description === "string" ? raw.description : undefined, requirementRefs: stringArray(raw?.requirementRefs)\n      })),\n      requiredValidations: arrayValue(rawContract.requiredValidations).map((raw: any, index) => ({\n        id: stringValue(raw?.id, `steer-validation-${index + 1}`), description: stringValue(raw?.description, `Validate steered output ${index + 1}`),\n        level: validationLevel(raw?.level), requirementRefs: stringArray(raw?.requirementRefs), runtime: runtimeValidation(raw?.runtime), integration: integrationValidation(raw?.integration)\n      })),\n      criticalFailureConditions: stringArray(rawContract.criticalFailureConditions),\n      completionPolicy: { requireAllCritical: true, requireAllRequired: true, allowPreferredOpen: true }\n    } : undefined;\n    return {\n      kind, reason: stringValue(value.reason, kind === "operational" ? "Operational steering" : input.message),\n      confidence: clamp01(numberValue(value.confidence, 0.7)), specPatch, revisedAcceptanceContract,\n      affectedRequirementRefs: stringArray(value.affectedRequirementRefs), affectedWorkItemRefs: stringArray(value.affectedWorkItemRefs),\n      affectedArtifactRefs: stringArray(value.affectedArtifactRefs),\n      strategyImpact: value.strategyImpact === "global" ? "global" : value.strategyImpact === "local" ? "local" : "none"\n    };\n  }\n\n'''
rep('src/core/planning/host-deliberation-provider.ts', marker, method+marker)

# Controller applies semantic revisions and invalidates only the analyzed scope.
rep('src/core/mission/controller.ts',
'''import type { DeliberationProvider, CompletionChallenge, GapDiagnosis } from "../planning/deliberation-provider.ts";''',
'''import type { DeliberationProvider, CompletionChallenge, GapDiagnosis } from "../planning/deliberation-provider.ts";\nimport type { SteeringApplicationResult, SteeringInterpretation } from "../domain/steering.ts";\nimport { SteeringImpactAnalyzer } from "../steering/steering-impact-analyzer.ts";''')
rep('src/core/mission/controller.ts',
'''  private readonly repairEnactment = new RepairEnactmentPolicy();''',
'''  private readonly repairEnactment = new RepairEnactmentPolicy();\n  private readonly steeringImpact = new SteeringImpactAnalyzer();''')
old='''  async steer(missionId: string, message: string) {\n    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });\n    return this.state(missionId);\n  }'''
new='''  async steer(missionId: string, message: string) {\n    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });\n    return this.state(missionId);\n  }\n\n  async steerWithImpact(missionId: string, message: string): Promise<SteeringApplicationResult> {\n    const before = await this.state(missionId);\n    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });\n    const [missionSpec, acceptanceContract, workItems, artifacts] = await Promise.all([\n      this.readModel.missionSpec(missionId), this.readModel.acceptanceContract(missionId),\n      this.readModel.workItems(missionId), this.readModel.artifacts(missionId)\n    ]);\n    if (!this.deliberation?.interpretSteering) {\n      return { impact: {\n        kind: "operational", reason: "No steering interpreter configured; preserved current mission semantics", confidence: 1,\n        previousMissionRevision: before.revision, strategyImpact: "none", affectedRequirementRefs: [],\n        invalidatedWorkItemRefs: [], invalidatedArtifactRefs: [],\n        unaffectedActiveWorkItemRefs: workItems.filter(work => ["ready", "running", "waiting", "verifying", "blocked"].includes(work.status)).map(work => work.id)\n      } };\n    }\n    const interpretation = await this.deliberation.interpretSteering({ missionId, message, state: await this.state(missionId), missionSpec, acceptanceContract, workItems, artifacts });\n    if (interpretation.kind === "operational") {\n      return { impact: this.steeringImpact.analyze({ missionRevision: before.revision, interpretation, workItems, artifacts }) };\n    }\n\n    const now = new Date().toISOString();\n    let revisedSpec = missionSpec ?? undefined;\n    if (interpretation.specPatch && missionSpec) {\n      revisedSpec = { ...missionSpec, ...definedPatch(interpretation.specPatch), revision: missionSpec.revision + 1, createdAt: now };\n      await this.emit(missionId, "mission.spec.revised", { revision: revisedSpec.revision, spec: revisedSpec, objective: revisedSpec.objective }, { type: "controller" }, `mission-spec:${missionId}:${revisedSpec.revision}`);\n    }\n\n    let revisedContract: AcceptanceContract | undefined;\n    let changedRequirementRefs: string[] = [];\n    if (interpretation.revisedAcceptanceContract) {\n      const previous = acceptanceContract;\n      const revision = (previous?.revision ?? 0) + 1;\n      changedRequirementRefs = acceptanceChangedRequirements(previous, interpretation.revisedAcceptanceContract);\n      const previousRequirements = new Map((previous?.requirements ?? []).map(requirement => [requirement.id, requirement]));\n      const affected = new Set([...interpretation.affectedRequirementRefs, ...changedRequirementRefs]);\n      revisedContract = {\n        ...interpretation.revisedAcceptanceContract, missionId, revision, createdAt: now,\n        requirements: interpretation.revisedAcceptanceContract.requirements.map(requirement => {\n          const old = previousRequirements.get(requirement.id);\n          const canPreserve = old && !affected.has(requirement.id) && sameRequirementMeaning(old, requirement);\n          return canPreserve ? { ...requirement, status: old.status, evidenceRefs: [...old.evidenceRefs] } : { ...requirement, status: "unverified", evidenceRefs: [] };\n        })\n      };\n      await this.emit(missionId, "acceptance.revised", { revision, contract: revisedContract }, { type: "controller" }, `acceptance:${missionId}:${revision}`);\n    }\n\n    const impact = this.steeringImpact.analyze({ missionRevision: before.revision, interpretation, workItems, artifacts, changedRequirementRefs });\n    impact.missionSpecRevision = revisedSpec?.revision;\n    impact.acceptanceRevision = revisedContract?.revision;\n    for (const workId of impact.invalidatedWorkItemRefs) {\n      await this.emit(missionId, "work.invalidated", { id: workId, reason: `User steering: ${interpretation.reason}` }, { type: "controller" }, `steering-work-invalidated:${before.revision}:${workId}`);\n    }\n    for (const artifactRef of impact.invalidatedArtifactRefs) {\n      await this.emit(missionId, "artifact.invalidated", { artifactRef, reason: `User steering: ${interpretation.reason}` }, { type: "controller" }, `steering-artifact-invalidated:${before.revision}:${artifactRef}`);\n    }\n    if (before.status === "completed" && (impact.invalidatedWorkItemRefs.length || impact.invalidatedArtifactRefs.length || revisedContract || revisedSpec)) {\n      await this.emit(missionId, "mission.reopened", { reason: interpretation.reason }, { type: "controller" }, `mission-reopened:steering:${before.revision}`);\n    }\n    if (interpretation.strategyImpact === "global" && this.deliberation) {\n      const state = await this.state(missionId);\n      const proposal = await this.deliberation.composeStrategy({ state, userGoal: revisedSpec?.objective ?? await this.readModel.userGoal(missionId), acceptanceContract: revisedContract ?? acceptanceContract });\n      const revision = Math.max((state.strategyRevision ?? 0) + 1, proposal.revision);\n      await this.emit(missionId, "strategy.revised", { ...proposal, revision, reason: interpretation.reason }, { type: "planner" }, `strategy:${missionId}:${revision}`);\n    }\n    return { impact, missionSpec: revisedSpec, acceptanceContract: revisedContract };\n  }'''
rep('src/core/mission/controller.ts', old, new)
# Steering cycle may expand an affected branch while unrelated work continues.
rep('src/core/mission/controller.ts',
'''    if (this.deliberation && this.shouldPlanFrontier(state)) {''',
'''    if (this.deliberation && (this.shouldPlanFrontier(state) || (input.trigger === "user_steering" && state.blockingGapIds.length === 0))) {''')
# Helpers before class end helper functions marker.
marker='''function diagnosisId(gapId: string, diagnosis: GapDiagnosis, sequence: number): string {'''
helpers='''function definedPatch<T extends Record<string, unknown>>(value: T): Partial<T> {\n  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;\n}\n\nfunction sameRequirementMeaning(a: Requirement, b: Requirement): boolean {\n  return a.description === b.description && a.type === b.type && a.priority === b.priority && a.verification === b.verification;\n}\n\nfunction acceptanceChangedRequirements(current: AcceptanceContract | null, revised: SteeringInterpretation["revisedAcceptanceContract"]): string[] {\n  if (!revised) return [];\n  const changed = new Set<string>();\n  const oldRequirements = new Map((current?.requirements ?? []).map(item => [item.id, item]));\n  const newRequirements = new Map(revised.requirements.map(item => [item.id, item]));\n  for (const [id, item] of oldRequirements) if (!newRequirements.has(id) || !sameRequirementMeaning(item, newRequirements.get(id)!)) changed.add(id);\n  for (const [id, item] of newRequirements) if (!oldRequirements.has(id) || !sameRequirementMeaning(oldRequirements.get(id)!, item)) changed.add(id);\n  const oldArtifacts = new Map((current?.requiredArtifacts ?? []).map(item => [item.logicalName, item]));\n  for (const artifact of revised.requiredArtifacts) {\n    const old = oldArtifacts.get(artifact.logicalName);\n    if (!old || JSON.stringify(old) !== JSON.stringify(artifact)) for (const ref of artifact.requirementRefs) changed.add(ref);\n    oldArtifacts.delete(artifact.logicalName);\n  }\n  for (const artifact of oldArtifacts.values()) for (const ref of artifact.requirementRefs) changed.add(ref);\n  const oldValidations = new Map((current?.requiredValidations ?? []).map(item => [item.id, item]));\n  for (const validation of revised.requiredValidations) {\n    const old = oldValidations.get(validation.id);\n    if (!old || JSON.stringify(old) !== JSON.stringify(validation)) for (const ref of validation.requirementRefs) changed.add(ref);\n    oldValidations.delete(validation.id);\n  }\n  for (const validation of oldValidations.values()) for (const ref of validation.requirementRefs) changed.add(ref);\n  return [...changed];\n}\n\n'''
rep('src/core/mission/controller.ts', marker, helpers+marker)

# Orchestrator tracks active work/execution ownership, cancels only affected work, and refuses stale results.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''  private readonly rerunRequested = new Set<string>();''',
'''  private readonly rerunRequested = new Set<string>();\n  private readonly activeExecutions = new Map<string, { missionId: string; workItemId: string; executionId: string }>();''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''  async runUntilQuiescent(missionId: string): Promise<void> {''',
'''  async cancelWorkItems(missionId: string, workItemIds: string[]): Promise<string[]> {\n    if (!this.executionRouter) return [];\n    const targets = [...this.activeExecutions.values()].filter(item => item.missionId === missionId && workItemIds.includes(item.workItemId));\n    const cancelled: string[] = [];\n    for (const target of targets) {\n      await this.controller.emit(missionId, "execution.cancel.requested", { id: target.executionId, reason: "user steering invalidated work" }, { type: "controller" }, `steering-cancel:${target.executionId}`);\n      if (await this.executionRouter.cancel(target.executionId)) cancelled.push(target.executionId);\n    }\n    return cancelled;\n  }\n\n  async runUntilQuiescent(missionId: string): Promise<void> {''')
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''    try {\n      await this.controller.emit(work.missionId, "execution.started",''',
'''    this.activeExecutions.set(executionId, { missionId: work.missionId, workItemId: work.id, executionId });\n    try {\n      await this.controller.emit(work.missionId, "execution.started",''')
# Before assurance, reject stale result.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''      if (result.state !== "succeeded" || envelope?.status === "failed") {\n        await this.failWork(work, attemptId, envelope?.summary ?? `Host execution ended as ${result.state}`);\n        return;\n      }\n      const outcome = await this.assurance.process(work, attemptId, workspace.root, envelope);''',
'''      if (await this.isWorkInvalidated(work.missionId, work.id)) {\n        await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "cancelled", reason: "Result superseded by user steering" }, { type: "controller" }, `attempt-completed:${attemptId}`);\n        return;\n      }\n      if (result.state !== "succeeded" || envelope?.status === "failed") {\n        await this.failWork(work, attemptId, envelope?.summary ?? `Host execution ended as ${result.state}`);\n        return;\n      }\n      const outcome = await this.assurance.process(work, attemptId, workspace.root, envelope);''')
# Catch/finally clean active map.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''    } catch (error) {\n      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: error instanceof Error ? error.message : String(error) }, { type: "host" }, `execution-settled:${executionId}`);\n      await this.failWork(work, attemptId, error instanceof Error ? error.message : String(error));\n    }\n  }''',
'''    } catch (error) {\n      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: error instanceof Error ? error.message : String(error) }, { type: "host" }, `execution-settled:${executionId}`);\n      if (!(await this.isWorkInvalidated(work.missionId, work.id))) await this.failWork(work, attemptId, error instanceof Error ? error.message : String(error));\n    } finally {\n      this.activeExecutions.delete(executionId);\n    }\n  }''')
# Add helper before acquisition work.
rep('src/runtime/orchestration/mission-orchestrator.ts',
'''  private async executeAcquisitionWork(work: WorkItem): Promise<void> {''',
'''  private async isWorkInvalidated(missionId: string, workId: string): Promise<boolean> {\n    const work = (await this.projections.listWorkItems(missionId)).find(item => item.id === workId);\n    return work?.status === "invalidated" || work?.status === "superseded" || work?.status === "abandoned";\n  }\n\n  private async executeAcquisitionWork(work: WorkItem): Promise<void> {''')

# Runtime owns the atomic steering workflow: apply scope, cancel affected executions, then replan/wake.
rep('src/runtime/mission-runtime.ts',
'''  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {''',
'''  async steer(missionId: string, message: string) {\n    const result = await this.controller.steerWithImpact(missionId, message);\n    if (result.impact.invalidatedWorkItemRefs.length > 0) {\n      await this.orchestrator?.cancelWorkItems(missionId, result.impact.invalidatedWorkItemRefs);\n    }\n    await this.controller.runControllerCycle({ missionId, trigger: "user_steering" });\n    this.orchestrator?.wake(missionId);\n    return result;\n  }\n\n  async cancelExecution(missionId: string, executionId: string): Promise<boolean> {''')

# API accepts a runtime steering hook instead of hard-wiring Controller.steer.
rep('src/server/mission-api.ts',
'''export interface MissionApiOptions {\n  projections?: MissionProjectionReader;\n  orchestrator?: MissionOrchestrator;\n}''',
'''export interface MissionApiOptions {\n  projections?: MissionProjectionReader;\n  orchestrator?: MissionOrchestrator;\n  steer?: (missionId: string, message: string) => Promise<unknown>;\n}''')
rep('src/server/mission-api.ts',
'''          const state = await controller.steer(missionId, body.message ?? "");\n          await controller.runControllerCycle({ missionId, trigger: "user_steering" });\n          options.orchestrator?.wake(missionId);\n          await publish(missionId);\n          return json(res, 200, state);''',
'''          const result = options.steer\n            ? await options.steer(missionId, body.message ?? "")\n            : await controller.steer(missionId, body.message ?? "");\n          if (!options.steer) {\n            await controller.runControllerCycle({ missionId, trigger: "user_steering" });\n            options.orchestrator?.wake(missionId);\n          }\n          await publish(missionId);\n          return json(res, 200, result);''')
rep('src/server/main.ts',
'''const server = createMissionApi(runtime.controller, runtime.events, { projections: runtime.projections, orchestrator: runtime.orchestrator });''',
'''const server = createMissionApi(runtime.controller, runtime.events, { projections: runtime.projections, orchestrator: runtime.orchestrator, steer: (missionId, message) => runtime.steer(missionId, message) });''')

# DSH plugin uses the same steering workflow.
rep('integrations/deepseek-plugin/src/index.ts',
'''      await runtime.controller.steer(args.mission_id, args.message);\n      await runtime.controller.runControllerCycle({ missionId: args.mission_id, trigger: "user_steering" });\n      runtime.orchestrator?.wake(args.mission_id);''',
'''      await runtime.steer(args.mission_id, args.message);''')
PY

cat > tests/integration/steering-impact.test.ts <<'TS'
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Artifact } from "../../src/core/domain/artifact.ts";

function setup(kind: "semantic" | "operational" = "semantic") {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const deliberation: DeliberationProvider = {
    async interpretSteering() {
      return kind === "operational" ? {
        kind: "operational", reason: "continue current mission", confidence: 1, affectedRequirementRefs: [], affectedWorkItemRefs: [], affectedArtifactRefs: [], strategyImpact: "none"
      } : {
        kind: "semantic", reason: "make technical narrative deeper", confidence: 0.95,
        specPatch: { preferences: ["technical depth over marketing tone"] },
        affectedRequirementRefs: ["r-tech"], affectedWorkItemRefs: [], affectedArtifactRefs: [], strategyImpact: "local"
      };
    },
    async composeStrategy() { return { framing: "technical", approach: "progressive", workstreams: [], revision: 1 }; },
    async planFrontier({ state }) { return { workItems: [], graphRevision: state.graphRevision }; },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 0.8 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
  return { db, projections, controller: new MissionController(events, { projections, deliberation }) };
}

function work(missionId: string, id: string, requirementRefs: string[], inputs: string[] = [], output?: string): WorkItem {
  const now = new Date().toISOString();
  return { id, missionId, purpose: "production", objective: id, status: "ready", requirementRefs, gapRefs: [], inputArtifactRefs: inputs,
    expectedOutputs: output ? [{ logicalName: output, type: "file", required: true }] : [], localAcceptanceCriteria: [], capabilityNeedRefs: [],
    priority: 50, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now };
}

async function seed(controller: MissionController, missionId: string) {
  await controller.createMission(missionId, "build a technical keynote");
  const now = new Date().toISOString();
  await controller.emit(missionId, "acceptance.revised", { revision: 2, contract: {
    missionId, revision: 2, createdAt: now,
    requirements: [
      { id: "r-tech", description: "technical narrative", type: "content", priority: "required", verification: "review", status: "unverified", evidenceRefs: [] },
      { id: "r-source", description: "source appendix", type: "evidence", priority: "required", verification: "evidence", status: "unverified", evidenceRefs: [] }
    ], requiredArtifacts: [], requiredValidations: [], criticalFailureConditions: []
  } }, { type: "controller" });
  await controller.proposeWork(work(missionId, "w-tech", ["r-tech"], [], "deck"));
  await controller.proposeWork(work(missionId, "w-source", ["r-source"], [], "sources"));
  await controller.proposeWork(work(missionId, "w-integrate", [], ["deck@1"], "final"));
  const deck: Artifact = { id: "deck", missionId, logicalName: "deck", type: "presentation", version: 1, status: "verified", uri: "/tmp/deck.pptx", contentHash: "a", producedByAttemptId: "a1", sourceArtifactRefs: [], createdAt: now };
  const preview: Artifact = { id: "preview", missionId, logicalName: "preview", type: "image", version: 1, status: "verified", uri: "/tmp/preview.png", contentHash: "b", producedByAttemptId: "a2", sourceArtifactRefs: ["deck@1"], createdAt: now };
  await controller.recordArtifact(missionId, deck); await controller.recordArtifact(missionId, preview);
}

test("semantic steering invalidates only affected work and artifact lineage while preserving unrelated frontier", async () => {
  const { db, projections, controller } = setup("semantic");
  await seed(controller, "m-steer");
  const before = await projections.getMissionSpec("m-steer");
  const result = await controller.steerWithImpact("m-steer", "less marketing, more technical depth");
  assert.equal(result.impact.kind, "semantic");
  assert.deepEqual(new Set(result.impact.invalidatedWorkItemRefs), new Set(["w-tech", "w-integrate"]));
  assert.deepEqual(result.impact.unaffectedActiveWorkItemRefs, ["w-source"]);
  assert.deepEqual(new Set(result.impact.invalidatedArtifactRefs), new Set(["deck@1", "preview@1"]));
  const after = await projections.getMissionSpec("m-steer");
  assert.equal(after?.revision, (before?.revision ?? 0) + 1);
  assert.deepEqual(after?.preferences, ["technical depth over marketing tone"]);
  const works = await projections.listWorkItems("m-steer");
  assert.equal(works.find(item => item.id === "w-tech")?.status, "invalidated");
  assert.equal(works.find(item => item.id === "w-integrate")?.status, "invalidated");
  assert.equal(works.find(item => item.id === "w-source")?.status, "ready");
  const artifacts = await projections.listArtifacts("m-steer");
  assert.equal(artifacts.find(item => item.id === "deck")?.status, "invalid");
  assert.equal(artifacts.find(item => item.id === "preview")?.status, "invalid");
  db.close();
});

test("operational steering records direction without revising mission or invalidating work", async () => {
  const { db, projections, controller } = setup("operational");
  await seed(controller, "m-continue");
  const before = await projections.getMissionSpec("m-continue");
  const result = await controller.steerWithImpact("m-continue", "continue");
  const after = await projections.getMissionSpec("m-continue");
  assert.equal(result.impact.kind, "operational");
  assert.equal(after?.revision, before?.revision);
  assert.deepEqual(result.impact.invalidatedWorkItemRefs, []);
  assert.equal((await projections.listWorkItems("m-continue")).filter(item => item.status === "ready").length, 3);
  db.close();
});
TS
