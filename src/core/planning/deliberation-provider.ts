import type { Artifact } from "../domain/artifact.ts";
import type { MissionState } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";
import type { CapabilityNeed } from "../domain/capability.ts";

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

export interface DeliberationMissionContext {
  state: MissionState;
  userGoal: string;
  workItems: WorkItem[];
  artifacts: Artifact[];
  openGaps: Gap[];
}

export interface DeliberationProvider {
  composeStrategy(input: { state: MissionState; userGoal: string }): Promise<StrategyProposal>;
  planFrontier(input: DeliberationMissionContext): Promise<FrontierProposal>;
  diagnoseGap(input: DeliberationMissionContext & { gap: Gap }): Promise<GapDiagnosis>;
  challengeCompletion(input: DeliberationMissionContext): Promise<CompletionChallenge>;
}
