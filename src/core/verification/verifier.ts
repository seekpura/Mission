import type { Artifact } from "../domain/artifact.ts";
import type { MissionState } from "../domain/mission.ts";
import type { Gap, VerificationResult } from "../domain/verification.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface VerificationContext {
  state: MissionState;
  workItem: WorkItem;
  gaps: Gap[];
}

export interface Verifier {
  id: string;
  verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult>;
}
