import type { AcceptanceContract, MissionSpec, MissionState } from "../domain/mission.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";

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

export interface GapDiagnosis {
  gapId: string;
  rootCause: string;
  intervention: "retry" | "revise_work" | "replace_capability" | "replan_local" | "revise_strategy";
  confidence: number;
}

export interface CompletionChallenge {
  blockingObjection: boolean;
  objections: Array<{ description: string; requirementRefs: string[]; artifactRefs: string[]; severity: "blocking" | "non_blocking" }>;
  confidence: number;
}

export interface DeliberationProvider {
  interpretMission?(input: { missionId: string; userGoal: string; state: MissionState }): Promise<MissionInterpretation>;
  composeStrategy(input: { state: MissionState; userGoal: string; acceptanceContract?: AcceptanceContract | null }): Promise<StrategyProposal>;
  planFrontier(input: { state: MissionState; userGoal: string; openGaps: Gap[]; acceptanceContract?: AcceptanceContract | null; requirements?: import("../domain/mission.ts").Requirement[] }): Promise<FrontierProposal>;
  diagnoseGap(input: { state: MissionState; gap: Gap }): Promise<GapDiagnosis>;
  challengeCompletion(input: { state: MissionState }): Promise<CompletionChallenge>;
}
