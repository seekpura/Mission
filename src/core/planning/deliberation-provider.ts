import type { CapabilityNeed } from "../domain/capability.ts";
import type { MissionState, MissionSteeringMessage } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";

export interface StrategyProposal {
  framing: string;
  approach: string;
  workstreams: Array<{ id: string; objective: string }>;
  revision: number;
  /** Runtime-owned checkpoint added when a durable strategy incorporates steering. */
  appliedSteeringSequence?: number;
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
  composeStrategy(input: {
    state: MissionState;
    userGoal: string;
    /** Durable user steering in Event sequence order. */
    steeringMessages?: MissionSteeringMessage[];
    /** Latest persisted strategy when this call is a steering-driven revision. */
    currentStrategy?: StrategyProposal;
  }): Promise<StrategyProposal>;
  planFrontier(input: { state: MissionState; openGaps: Gap[] }): Promise<FrontierProposal>;
  diagnoseGap(input: { state: MissionState; gap: Gap }): Promise<GapDiagnosis>;
  challengeCompletion(input: { state: MissionState }): Promise<CompletionChallenge>;
}
