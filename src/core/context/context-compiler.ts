import { randomUUID } from "node:crypto";
import type { ContextPacket } from "../domain/context.ts";
import type { MissionState, MissionSteeringMessage } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface ContextCompilerInput {
  state: MissionState;
  workItem: WorkItem;
  steeringMessages?: MissionSteeringMessage[];
  requirementRefs?: string[];
  constraintRefs?: string[];
  truthRefs?: string[];
  sourceRefs?: string[];
  artifactRefs?: string[];
  decisionRefs?: string[];
  capabilityRefs?: string[];
  recentFailureRefs?: string[];
}

export class ContextCompiler {
  compile(input: ContextCompilerInput): ContextPacket {
    const w = input.workItem;
    return {
      id: randomUUID(),
      missionId: w.missionId,
      workItemId: w.id,
      objective: w.objective,
      ...(input.steeringMessages && input.steeringMessages.length > 0
        ? { steeringMessages: input.steeringMessages.map(message => ({ ...message })) }
        : {}),
      requirementRefs: unique([...(input.requirementRefs ?? []), ...w.requirementRefs]),
      constraintRefs: unique(input.constraintRefs ?? []),
      truthRefs: unique(input.truthRefs ?? []),
      sourceRefs: unique(input.sourceRefs ?? []),
      artifactRefs: unique([...(input.artifactRefs ?? []), ...w.inputArtifactRefs]),
      decisionRefs: unique(input.decisionRefs ?? []),
      localAcceptanceCriteria: w.localAcceptanceCriteria,
      allowedCapabilityRefs: unique(input.capabilityRefs ?? []),
      recentFailureRefs: unique(input.recentFailureRefs ?? []),
      contextVersion: input.state.revision,
      compilerManifest: {
        missionRevision: input.state.revision,
        graphRevision: input.state.graphRevision,
        generatedAt: new Date().toISOString()
      }
    };
  }
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
