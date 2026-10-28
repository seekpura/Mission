import { randomUUID } from "node:crypto";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { AcceptanceContract, MissionSpec, Requirement, RequiredArtifact, RequiredValidation } from "../domain/mission.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { WorkItem, WorkPurpose } from "../domain/work-item.ts";
import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge, MissionInterpretation } from "./deliberation-provider.ts";

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
    "requiredValidations":[{"id":string,"description":string,"level":"structural|functional|quality|integration|mission","requirementRefs":string[]}],
    "criticalFailureConditions":string[]
  }
}
Create an acceptance contract that captures the actual end goal, not implementation steps. Critical/required requirements must be objectively checkable. Use stable short ids. Do not invent extra deliverables the user did not request.
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
      requirementRefs: stringArray(raw?.requirementRefs)
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
Return ONLY JSON: {"gapId":string,"rootCause":string,"intervention":"retry|revise_work|replace_capability|replan_local|revise_strategy","confidence":number}.
Choose the minimum sufficient repair scope. Repeated semantic failures should escalate beyond retry.
`);
    const intervention = ["retry", "revise_work", "replace_capability", "replan_local", "revise_strategy"].includes(value.intervention)
      ? value.intervention as GapDiagnosis["intervention"] : "revise_work";
    return {
      gapId: input.gap.id,
      rootCause: stringValue(value.rootCause, input.gap.description),
      intervention,
      confidence: clamp01(numberValue(value.confidence, 0.7))
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
