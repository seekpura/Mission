export interface ContextPacket {
  id: string;
  missionId: string;
  workItemId: string;
  objective: string;
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
