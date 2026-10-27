import { randomUUID } from "node:crypto";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { WorkItem, WorkPurpose } from "../domain/work-item.ts";
import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge } from "./deliberation-provider.ts";

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

  async composeStrategy(input: Parameters<DeliberationProvider["composeStrategy"]>[0]): Promise<StrategyProposal> {
    const value = await this.askJson(input.state.missionId, "strategy", `
You are the Mission Runtime Strategy Composer.
Goal: ${input.userGoal}
Current mission state: ${JSON.stringify(input.state)}
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
Plan ONLY the next useful execution frontier, not the entire mission. Prefer 1-4 meaningful work items. Do not create tiny coordination tasks.
Return ONLY JSON: {"graphRevision":number,"workItems":[{"id":string,"purpose":"exploration|production|verification|repair|acquisition|integration","objective":string,"requirementRefs":string[],"gapRefs":string[],"inputArtifactRefs":string[],"capabilityNeedRefs":string[],"priority":number}]}.
Use purpose=exploration when the direction is still uncertain and there is no stronger requirement/gap linkage.
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
        expectedOutputs: [],
        localAcceptanceCriteria: [],
        capabilityNeedRefs,
        priority: Math.max(0, Math.min(100, numberValue(raw?.priority, 50))),
        graphRevision: nextRevision,
        createdBy: "planner",
        createdAt: now,
        updatedAt: now
      };
    });
    return { workItems, graphRevision: nextRevision };
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
