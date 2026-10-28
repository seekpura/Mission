import type { MissionSteeringMessage } from "./mission.ts";

export interface ContextPacket {
  id: string;
  missionId: string;
  workItemId: string;
  objective: string;
  /** Durable user steering visible to the Worker for this Mission revision. */
  steeringMessages?: MissionSteeringMessage[];
  requirementRefs: string[];
  constraintRefs: string[];
  truthRefs: string[];
  sourceRefs: string[];
  artifactRefs: string[];
  decisionRefs: string[];
  localAcceptanceCriteria: Array<{ id: string; description: string; priority: string }>;
  allowedCapabilityRefs: string[];
  recentFailureRefs: string[];
  contextVersion: number;
  compilerManifest: {
    missionRevision: number;
    graphRevision: number;
    generatedAt: string;
  };
}
