import { randomUUID } from "node:crypto";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { AcceptanceContract, MissionSpec, Requirement, RequiredArtifact, RequiredValidation } from "../domain/mission.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { WorkItem, WorkPurpose } from "../domain/work-item.ts";
import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge, MissionInterpretation } from "./deliberation-provider.ts";
import type { SteeringInterpretation } from "../domain/steering.ts";

export interface HostDeliberationOptions {
  capabilityRefs?: string[];
  workspaceRoot?: string;
}

export class HostDeliberationProvider implements DeliberationProvider {
  private readonly host: HostAdapter;
  private readonly options: HostDeliberationOptions;

  constructor(host: HostAdapter, options: HostDeliberationOptions = {}) {
    this.host = host;
    this.options = options;
  }

  async interpretMission(input: { missionId: string; userGoal: string; state: import("../domain/mission.ts").MissionState }): Promise<MissionInterpretation> {
    const value = await this.askJson(input.missionId, "interpret", `
You are the Mission Runtime Interpreter and Acceptance Composer.
User goal: ${input.userGoal}
Return ONLY JSON with this shape:
{
  "missionSpec": {"objective":string,"intent":string,"requestedOutputs":string[],"constraints":string[],"preferences":string[],"sourceRefs":string[]},
  "acceptanceContract": {
    "requirements":[{"id":string,"description":string,"type":"functional|content|visual|technical|evidence|experience|compliance","priority":"critical|required|preferred","verification":"artifact|test|review|evidence|runtime|human"}],
    "requiredArtifacts":[{"logicalName":string,"type":string,"description":string,"requirementRefs":string[]}],
    "requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[],"runtime"?:{"command":string,"args":string[],"timeoutMs":number},"integration"?:{"mode":"artifacts-present","artifactLogicalNames":string[]}}],
    "criticalFailureConditions":string[]
  }
}
Create an acceptance contract that captures the actual end goal, not implementation steps. Critical/required requirements must be objectively checkable. Use stable short ids. Do not invent extra deliverables the user did not request. For functional/runtime validation, include runtime only when a concrete direct executable and argument vector can be stated; never use shell pipelines, redirection, or command strings containing multiple commands. For integration checks that only require presence of named artifacts, use integration.mode=artifacts-present.
`);
    const now = new Date().toISOString();
    const rawSpec = value.missionSpec ?? {};
    const rawContract = value.acceptanceContract ?? {};
    const requirements: Requirement[] = arrayValue(rawContract.requirements).map((raw: any, index) => ({
      id: stringValue(raw?.id, `R${index + 1}`),
      description: stringValue(raw?.description, `Satisfy mission requirement ${index + 1}`),
      type: requirementType(raw?.type),
      priority: requirementPriority(raw?.priority),
      verification: requirementVerification(raw?.verification),
      status: "unverified",
      evidenceRefs: []
    }));
    const requiredArtifacts: RequiredArtifact[] = arrayValue(rawContract.requiredArtifacts).map((raw: any, index) => ({
      logicalName: stringValue(raw?.logicalName, `deliverable-${index + 1}`),
      type: typeof raw?.type === "string" ? raw.type : undefined,
      description: typeof raw?.description === "string" ? raw.description : undefined,
      requirementRefs: stringArray(raw?.requirementRefs)
    }));
    const requiredValidations: RequiredValidation[] = arrayValue(rawContract.requiredValidations).map((raw: any, index) => ({
      id: stringValue(raw?.id, `validation-${index + 1}`),
      description: stringValue(raw?.description, `Validate mission output ${index + 1}`),
      level: validationLevel(raw?.level),
      requirementRefs: stringArray(raw?.requirementRefs),
      runtime: runtimeValidation(raw?.runtime),
      integration: integrationValidation(raw?.integration)
    }));
    const missionSpec: MissionSpec = {
      missionId: input.missionId,
      revision: 1,
      objective: stringValue(rawSpec.objective, input.userGoal),
      intent: typeof rawSpec.intent === "string" ? rawSpec.intent : undefined,
      requestedOutputs: stringArray(rawSpec.requestedOutputs),
      constraints: stringArray(rawSpec.constraints),
      preferences: stringArray(rawSpec.preferences),
      sourceRefs: stringArray(rawSpec.sourceRefs),
      createdAt: now
    };
    const acceptanceContract: AcceptanceContract = {
      missionId: input.missionId,
      revision: 1,
      requirements,
      requiredArtifacts,
      requiredValidations,
      criticalFailureConditions: stringArray(rawContract.criticalFailureConditions),
      completionPolicy: { requireAllCritical: true, requireAllRequired: true, allowPreferredOpen: true },
      createdAt: now
    };
    return { missionSpec, acceptanceContract };
  }

  async interpretSteering(input: Parameters<NonNullable<DeliberationProvider["interpretSteering"]>>[0]): Promise<SteeringInterpretation> {
    const value = await this.askJson(input.missionId, "steering", `
You are the Mission Runtime Steering Interpreter.
User steering: ${input.message}
Current MissionSpec: ${JSON.stringify(input.missionSpec)}
Current AcceptanceContract: ${JSON.stringify(input.acceptanceContract)}
Current work: ${JSON.stringify(input.workItems.map(work => ({ id: work.id, status: work.status, purpose: work.purpose, objective: work.objective, requirementRefs: work.requirementRefs, inputArtifactRefs: work.inputArtifactRefs, expectedOutputs: work.expectedOutputs })))}
Current artifacts: ${JSON.stringify(input.artifacts.map(artifact => ({ ref: `${artifact.id}@${artifact.version}`, logicalName: artifact.logicalName, status: artifact.status, sourceArtifactRefs: artifact.sourceArtifactRefs })))}
Classify pure operational messages such as "continue", "resume", or simple sequencing as kind=operational. They must not rewrite the mission.
For semantic changes, return only the smallest scope affected. Do not invalidate unrelated work. If the user changes required deliverables or completion criteria, return a complete revisedAcceptanceContract; otherwise omit it.
Return ONLY JSON: {
  "kind":"operational|semantic",
  "reason":string,
  "confidence":number,
  "specPatch":{"objective"?:string,"intent"?:string,"requestedOutputs"?:string[],"constraints"?:string[],"preferences"?:string[],"sourceRefs"?:string[]} | null,
  "revisedAcceptanceContract":{"requirements":[{"id":string,"description":string,"type":"functional|content|visual|technical|evidence|experience|compliance","priority":"critical|required|preferred","verification":"artifact|test|review|evidence|runtime|human"}],"requiredArtifacts":[{"logicalName":string,"type":string,"description":string,"requirementRefs":string[]}],"requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[]}],"criticalFailureConditions":string[]} | null,
  "affectedRequirementRefs":string[],
  "affectedWorkItemRefs":string[],
  "affectedArtifactRefs":string[],
  "strategyImpact":"none|local|global"
}.
`);
    const kind = value.kind === "semantic" ? "semantic" as const : "operational" as const;
    const rawPatch = value.specPatch && typeof value.specPatch === "object" ? value.specPatch : undefined;
    const specPatch = rawPatch ? {
      objective: typeof rawPatch.objective === "string" ? rawPatch.objective : undefined,
      intent: typeof rawPatch.intent === "string" ? rawPatch.intent : undefined,
      requestedOutputs: Array.isArray(rawPatch.requestedOutputs) ? stringArray(rawPatch.requestedOutputs) : undefined,
      constraints: Array.isArray(rawPatch.constraints) ? stringArray(rawPatch.constraints) : undefined,
      preferences: Array.isArray(rawPatch.preferences) ? stringArray(rawPatch.preferences) : undefined,
      sourceRefs: Array.isArray(rawPatch.sourceRefs) ? stringArray(rawPatch.sourceRefs) : undefined
    } : undefined;
    const rawContract = value.revisedAcceptanceContract;
    const revisedAcceptanceContract = rawContract && typeof rawContract === "object" ? {
      requirements: arrayValue(rawContract.requirements).map((raw: any, index) => ({
        id: stringValue(raw?.id, `steer-R${index + 1}`), description: stringValue(raw?.description, `Steered requirement ${index + 1}`),
        type: requirementType(raw?.type), priority: requirementPriority(raw?.priority), verification: requirementVerification(raw?.verification),
        status: "unverified" as const, evidenceRefs: []
      })),
      requiredArtifacts: arrayValue(rawContract.requiredArtifacts).map((raw: any, index) => ({
        logicalName: stringValue(raw?.logicalName, `deliverable-${index + 1}`), type: typeof raw?.type === "string" ? raw.type : undefined,
        description: typeof raw?.description === "string" ? raw.description : undefined, requirementRefs: stringArray(raw?.requirementRefs)
      })),
      requiredValidations: arrayValue(rawContract.requiredValidations).map((raw: any, index) => ({
        id: stringValue(raw?.id, `steer-validation-${index + 1}`), description: stringValue(raw?.description, `Validate steered output ${index + 1}`),
        level: validationLevel(raw?.level), requirementRefs: stringArray(raw?.requirementRefs), runtime: runtimeValidation(raw?.runtime), integration: integrationValidation(raw?.integration)
      })),
      criticalFailureConditions: stringArray(rawContract.criticalFailureConditions),
      completionPolicy: { requireAllCritical: true, requireAllRequired: true, allowPreferredOpen: true }
    } : undefined;
    return {
      kind, reason: stringValue(value.reason, kind === "operational" ? "Operational steering" : input.message),
      confidence: clamp01(numberValue(value.confidence, 0.7)), specPatch, revisedAcceptanceContract,
      affectedRequirementRefs: stringArray(value.affectedRequirementRefs), affectedWorkItemRefs: stringArray(value.affectedWorkItemRefs),
      affectedArtifactRefs: stringArray(value.affectedArtifactRefs),
      strategyImpact: value.strategyImpact === "global" ? "global" : value.strategyImpact === "local" ? "local" : "none"
    };
  }

  async composeStrategy(input: Parameters<DeliberationProvider["composeStrategy"]>[0]): Promise<StrategyProposal> {
    const value = await this.askJson(input.state.missionId, "strategy", `
You are the Mission Runtime Strategy Composer.
Goal: ${input.userGoal}
Current mission state: ${JSON.stringify(input.state)}
Acceptance contract: ${JSON.stringify(input.acceptanceContract ?? null)}
Return ONLY JSON with: framing:string, approach:string, workstreams:[{id:string,objective:string}], revision:number.
Design the strategy for this mission specifically. Do not emit a fixed workflow. Keep distant uncertain work coarse.
`);
    return {
      framing: stringValue(value.framing, input.userGoal),
      approach: stringValue(value.approach, "progressive mission-specific execution"),
      workstreams: arrayValue(value.workstreams).map((item: any, index) => ({ id: stringValue(item?.id, `workstream-${index + 1}`), objective: stringValue(item?.objective, "Advance the mission") })),
      revision: numberValue(value.revision, Math.max(1, (input.state.strategyRevision ?? 0) + 1))
    };
  }

  async planFrontier(input: Parameters<DeliberationProvider["planFrontier"]>[0]): Promise<FrontierProposal> {
    const value = await this.askJson(input.state.missionId, "frontier", `
You are the Mission Runtime Frontier Planner.
Goal: ${input.userGoal}
Current state: ${JSON.stringify(input.state)}
Open gaps: ${JSON.stringify(input.openGaps)}
Acceptance contract: ${JSON.stringify(input.acceptanceContract ?? null)}
Requirements: ${JSON.stringify(input.requirements ?? [])}
Plan ONLY the next useful execution frontier, not the entire mission. Prefer 1-4 meaningful work items. Do not create tiny coordination tasks.
Return ONLY JSON: {"graphRevision":number,"capabilityNeeds":[{"id":string,"objective":string,"requiredFunctions":string[],"desiredInputs":string[],"desiredOutputs":string[],"purpose":"production|verification|research|integration","urgency":"blocking|high-value|optional-improvement","acquisitionAllowed":boolean,"maxRisk":"low|medium|high","requirementRefs":string[],"gapRefs":string[]}],"workItems":[{"id":string,"purpose":"exploration|production|verification|repair|acquisition|integration","objective":string,"requirementRefs":string[],"gapRefs":string[],"inputArtifactRefs":string[],"capabilityNeedRefs":string[],"priority":number,"expectedOutputs":[{"logicalName":string,"type":string,"required":boolean}]}]}.
Only create a CapabilityNeed when the current environment may not already provide a required function. A WorkItem capabilityNeedRefs must reference ids from capabilityNeeds. When a work item produces a required deliverable, use the exact requiredArtifacts.logicalName and attach its requirementRefs. Use purpose=exploration when the direction is still uncertain and there is no stronger requirement/gap linkage.
`);
    const now = new Date().toISOString();
    const nextRevision = Math.max(input.state.graphRevision + 1, numberValue(value.graphRevision, input.state.graphRevision + 1));
    const workItems: WorkItem[] = arrayValue(value.workItems).slice(0, 8).map((raw: any, index) => {
      const purpose = purposeValue(raw?.purpose);
      const requirementRefs = stringArray(raw?.requirementRefs);
      const gapRefs = stringArray(raw?.gapRefs);
      const inputArtifactRefs = stringArray(raw?.inputArtifactRefs);
      const capabilityNeedRefs = stringArray(raw?.capabilityNeedRefs);
      return {
        id: stringValue(raw?.id, `work-${nextRevision}-${index + 1}-${randomUUID().slice(0, 6)}`),
        missionId: input.state.missionId,
        purpose,
        objective: stringValue(raw?.objective, "Advance the current mission frontier"),
        status: "ready",
        requirementRefs,
        gapRefs,
        inputArtifactRefs,
        expectedOutputs: arrayValue(raw?.expectedOutputs).map((output: any) => ({
          logicalName: stringValue(output?.logicalName, `artifact-${index + 1}`),
          type: stringValue(output?.type, "file"),
          required: output?.required !== false
        })),
        localAcceptanceCriteria: [],
        capabilityNeedRefs,
        priority: Math.max(0, Math.min(100, numberValue(raw?.priority, 50))),
        graphRevision: nextRevision,
        createdBy: "planner",
        createdAt: now,
        updatedAt: now
      };
    });
    const capabilityNeeds: CapabilityNeed[] = arrayValue(value.capabilityNeeds).slice(0, 8).map((raw: any, index) => ({
        id: stringValue(raw?.id, `need-${nextRevision}-${index + 1}`),
        missionId: input.state.missionId,
        objective: stringValue(raw?.objective, "Provide a capability required by the current frontier"),
        requiredFunctions: stringArray(raw?.requiredFunctions),
        desiredInputs: stringArray(raw?.desiredInputs),
        desiredOutputs: stringArray(raw?.desiredOutputs),
        purpose: capabilityPurpose(raw?.purpose),
        urgency: capabilityUrgency(raw?.urgency),
        acquisitionAllowed: raw?.acquisitionAllowed !== false,
        maxRisk: capabilityRisk(raw?.maxRisk),
        requirementRefs: stringArray(raw?.requirementRefs),
        gapRefs: stringArray(raw?.gapRefs),
        status: "checking-installed"
      }));
      return { workItems, capabilityNeeds, graphRevision: nextRevision };
  }

  async diagnoseGap(input: Parameters<DeliberationProvider["diagnoseGap"]>[0]): Promise<GapDiagnosis> {
    const value = await this.askJson(input.state.missionId, `gap-${input.gap.id}`, `
You are the Mission Runtime Gap Diagnostician.
State: ${JSON.stringify(input.state)}
Gap: ${JSON.stringify(input.gap)}
Findings: ${JSON.stringify(input.findings ?? [])}
Evidence: ${JSON.stringify(input.evidence ?? [])}
Related work items: ${JSON.stringify(input.relatedWorkItems ?? [])}
Prior repair count: ${input.priorRepairCount ?? 0}
Progress / plateau context: ${JSON.stringify(input.plateauContext ?? null)}
If progress has stalled, consider a broader intervention than the already-attempted scopes, but only when the supplied findings/evidence support that root cause.
Generate competing root-cause hypotheses before choosing a repair scope. Prefer the minimum sufficient repair. A repeated semantic failure must not be treated as the same transient attempt retry. Do not claim a root cause unsupported by the supplied findings/evidence.
Return ONLY JSON: {"gapId":string,"rootCause":string,"hypotheses":[{"statement":string,"confidence":number,"findingRefs":string[],"evidenceRefs":string[]}],"repairScope":"attempt|work_item|executor|capability|graph|strategy","intervention":"retry|revise_work|replace_executor|replace_capability|replan_local|revise_strategy","confidence":number,"evidenceRefs":string[],"rootCauseKeyCandidate":string|null}.
`);
    const allowedInterventions = ["retry", "revise_work", "replace_executor", "replace_capability", "replan_local", "revise_strategy"];
    const intervention = allowedInterventions.includes(value.intervention)
      ? value.intervention as GapDiagnosis["intervention"] : "revise_work";
    const allowedScopes = ["attempt", "work_item", "executor", "capability", "graph", "strategy"];
    const repairScope = allowedScopes.includes(value.repairScope) ? value.repairScope as NonNullable<GapDiagnosis["repairScope"]> : undefined;
    const hypotheses = arrayValue(value.hypotheses).slice(0, 5).map((raw: any) => ({
      statement: stringValue(raw?.statement, stringValue(value.rootCause, input.gap.description)),
      confidence: clamp01(numberValue(raw?.confidence, 0.5)),
      findingRefs: stringArray(raw?.findingRefs),
      evidenceRefs: stringArray(raw?.evidenceRefs)
    }));
    return {
      gapId: input.gap.id,
      rootCause: stringValue(value.rootCause, input.gap.description),
      intervention,
      repairScope,
      confidence: clamp01(numberValue(value.confidence, 0.7)),
      evidenceRefs: stringArray(value.evidenceRefs),
      hypotheses,
      rootCauseKeyCandidate: typeof value.rootCauseKeyCandidate === "string" && value.rootCauseKeyCandidate.trim() ? value.rootCauseKeyCandidate.trim() : undefined
    };
  }

  async challengeCompletion(input: Parameters<DeliberationProvider["challengeCompletion"]>[0]): Promise<CompletionChallenge> {
    const value = await this.askJson(input.state.missionId, "completion", `
You are the independent Mission Completion Challenger.
State: ${JSON.stringify(input.state)}
Try to find a concrete reason this mission must NOT be declared complete. Focus on missing outputs, unresolved required work, unsupported claims, invalid artifacts, integration failures, stale evidence, or goal drift. Do not suggest cosmetic polish.
Return ONLY JSON: {"blockingObjection":boolean,"objections":[{"description":string,"requirementRefs":string[],"artifactRefs":string[],"severity":"blocking|non_blocking"}],"confidence":number}.
`);
    const objections = arrayValue(value.objections).map((raw: any) => ({
      description: stringValue(raw?.description, "Completion evidence is insufficient"),
      requirementRefs: stringArray(raw?.requirementRefs),
      artifactRefs: stringArray(raw?.artifactRefs),
      severity: raw?.severity === "blocking" ? "blocking" as const : "non_blocking" as const
    }));
    return {
      blockingObjection: Boolean(value.blockingObjection) || objections.some(item => item.severity === "blocking"),
      objections,
      confidence: clamp01(numberValue(value.confidence, 0.7))
    };
  }

  private async askJson(missionId: string, role: string, prompt: string): Promise<any> {
    const handle = await this.host.createAgent({
      missionId,
      workItemId: `deliberation-${role}-${randomUUID().slice(0, 8)}`,
      context: prompt,
      allowedCapabilityRefs: this.options.capabilityRefs ?? [],
      workspaceRoot: this.options.workspaceRoot
    });
    let text = "";
    let failure: unknown;
    for await (const event of this.host.observeAgent(handle)) {
      if (event.type === "completed") text = completionText(event.payload);
      if (event.type === "failed") failure = event.payload;
    }
    if (failure !== undefined) throw new Error(`Host deliberation failed: ${typeof failure === "string" ? failure : JSON.stringify(failure)}`);
    return parseJsonObject(text);
  }
}

function completionText(payload: unknown): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && typeof (payload as any).text === "string") return (payload as any).text;
  return JSON.stringify(payload ?? {});
}

function parseJsonObject(text: string): any {
  const stripped = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(stripped); } catch {}
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(stripped.slice(start, end + 1));
  throw new Error(`Deliberation did not return JSON: ${text.slice(0, 300)}`);
}

function stringValue(value: unknown, fallback: string): string { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function numberValue(value: unknown, fallback: number): number { return typeof value === "number" && Number.isFinite(value) ? value : fallback; }
function arrayValue(value: unknown): any[] { return Array.isArray(value) ? value : []; }
function stringArray(value: unknown): string[] { return arrayValue(value).filter((item): item is string => typeof item === "string"); }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function purposeValue(value: unknown): WorkPurpose {
  return ["exploration", "production", "verification", "repair", "acquisition", "integration"].includes(String(value)) ? value as WorkPurpose : "exploration";
}

function requirementType(value: unknown): Requirement["type"] { const allowed = ["functional","content","visual","technical","evidence","experience","compliance"] as const; return (allowed as readonly unknown[]).includes(value) ? value as Requirement["type"] : "functional"; }
function requirementPriority(value: unknown): Requirement["priority"] { return value === "critical" || value === "preferred" ? value : "required"; }
function requirementVerification(value: unknown): Requirement["verification"] { const allowed = ["artifact","test","review","evidence","runtime","human"] as const; return (allowed as readonly unknown[]).includes(value) ? value as Requirement["verification"] : "evidence"; }
function validationLevel(value: unknown): RequiredValidation["level"] { const allowed = ["structural","functional","quality","integration","mission"] as const; return (allowed as readonly unknown[]).includes(value) ? value as RequiredValidation["level"] : undefined; }

function capabilityPurpose(value: unknown): CapabilityNeed["purpose"] { return ["production","verification","research","integration"].includes(String(value)) ? value as CapabilityNeed["purpose"] : "production"; }
function capabilityUrgency(value: unknown): CapabilityNeed["urgency"] { return ["blocking","high-value","optional-improvement"].includes(String(value)) ? value as CapabilityNeed["urgency"] : "blocking"; }
function capabilityRisk(value: unknown): CapabilityNeed["maxRisk"] { return ["low","medium","high"].includes(String(value)) ? value as CapabilityNeed["maxRisk"] : "medium"; }

function runtimeValidation(value: unknown): RequiredValidation["runtime"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (typeof raw.command !== "string" || !raw.command.trim()) return undefined;
  if (/\n|\r|[;&|><`]/.test(raw.command)) return undefined;
  return { command: raw.command.trim(), args: stringArray(raw.args), timeoutMs: typeof raw.timeoutMs === "number" ? Math.max(1000, Math.min(120000, raw.timeoutMs)) : undefined };
}
function integrationValidation(value: unknown): RequiredValidation["integration"] {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as any;
  if (raw.mode !== "artifacts-present") return undefined;
  const artifactLogicalNames = stringArray(raw.artifactLogicalNames);
  return artifactLogicalNames.length > 0 ? { mode: "artifacts-present", artifactLogicalNames } : undefined;
}
