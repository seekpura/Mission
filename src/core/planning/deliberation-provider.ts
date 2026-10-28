import type { AcceptanceContract, MissionSpec, MissionState } from "../domain/mission.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Evidence, Finding, Gap } from "../domain/verification.ts";
import type { Artifact } from "../domain/artifact.ts";
import type { SteeringInterpretation } from "../domain/steering.ts";

export interface MissionInterpretation {
  missionSpec: MissionSpec;
  acceptanceContract: AcceptanceContract;
}

export interface StrategyProposal {
  framing: string;
  approach: string;
  workstreams: Array<{ id: string; objective: string }>;
  revision: number;
}

export interface FrontierProposal {
  workItems: WorkItem[];
  capabilityNeeds?: CapabilityNeed[];
  graphRevision: number;
}

export type RepairScope = "attempt" | "work_item" | "executor" | "capability" | "graph" | "strategy";

export interface RootCauseHypothesis {
  statement: string;
  confidence: number;
  findingRefs: string[];
  evidenceRefs: string[];
}

export interface GapDiagnosis {
  gapId: string;
  rootCause: string;
  intervention: "retry" | "revise_work" | "replace_executor" | "replace_capability" | "replan_local" | "revise_strategy";
  confidence: number;
  repairScope?: RepairScope;
  hypotheses?: RootCauseHypothesis[];
  evidenceRefs?: string[];
  rootCauseKeyCandidate?: string;
}

export interface CompletionChallenge {
  blockingObjection: boolean;
  objections: Array<{ description: string; requirementRefs: string[]; artifactRefs: string[]; severity: "blocking" | "non_blocking" }>;
  confidence: number;
}

export interface DeliberationProvider {
  interpretMission?(input: { missionId: string; userGoal: string; state: MissionState }): Promise<MissionInterpretation>;
  interpretSteering?(input: {
    missionId: string;
    message: string;
    state: MissionState;
    missionSpec: MissionSpec | null;
    acceptanceContract: AcceptanceContract | null;
    workItems: WorkItem[];
    artifacts: Artifact[];
  }): Promise<SteeringInterpretation>;
  composeStrategy(input: { state: MissionState; userGoal: string; acceptanceContract?: AcceptanceContract | null }): Promise<StrategyProposal>;
  planFrontier(input: { state: MissionState; userGoal: string; openGaps: Gap[]; acceptanceContract?: AcceptanceContract | null; requirements?: import("../domain/mission.ts").Requirement[] }): Promise<FrontierProposal>;
  diagnoseGap(input: {
    state: MissionState;
    gap: Gap;
    findings?: Finding[];
    evidence?: Evidence[];
    relatedWorkItems?: WorkItem[];
    priorRepairCount?: number;
  }): Promise<GapDiagnosis>;
  challengeCompletion(input: { state: MissionState }): Promise<CompletionChallenge>;
}
