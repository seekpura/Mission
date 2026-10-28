import type { AcceptanceContract, MissionSpec } from "./mission.ts";

export type SteeringKind = "operational" | "semantic";
export type SteeringStrategyImpact = "none" | "local" | "global";

export interface MissionSpecPatch {
  objective?: string;
  intent?: string;
  requestedOutputs?: string[];
  constraints?: string[];
  preferences?: string[];
  sourceRefs?: string[];
}

export interface SteeringInterpretation {
  kind: SteeringKind;
  reason: string;
  confidence: number;
  specPatch?: MissionSpecPatch;
  revisedAcceptanceContract?: Omit<AcceptanceContract, "missionId" | "revision" | "createdAt">;
  affectedRequirementRefs: string[];
  affectedWorkItemRefs: string[];
  affectedArtifactRefs: string[];
  strategyImpact: SteeringStrategyImpact;
}

export interface SteeringImpact {
  kind: SteeringKind;
  reason: string;
  confidence: number;
  previousMissionRevision: number;
  missionSpecRevision?: number;
  acceptanceRevision?: number;
  strategyImpact: SteeringStrategyImpact;
  affectedRequirementRefs: string[];
  invalidatedWorkItemRefs: string[];
  invalidatedArtifactRefs: string[];
  unaffectedActiveWorkItemRefs: string[];
}

export interface SteeringApplicationResult {
  impact: SteeringImpact;
  missionSpec?: MissionSpec;
  acceptanceContract?: AcceptanceContract;
}
