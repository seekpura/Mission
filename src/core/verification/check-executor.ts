import type { Artifact } from "../domain/artifact.ts";
import type { InspectionOutcome } from "../domain/inspection.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";

export interface VerificationCheckExecutorContext {
  missionId: string;
  artifacts?: Artifact[];
  inspection?: InspectionOutcome;
}

export interface VerificationCheckExecutor {
  id: string;
  cacheVersion?: string;
  supports(check: VerificationCheck, artifact: Artifact): boolean;
  execute(artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult>;
}
