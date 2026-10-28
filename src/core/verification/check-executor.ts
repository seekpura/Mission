import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";

export interface VerificationCheckExecutorContext {
  missionId: string;
}

export interface VerificationCheckExecutor {
  id: string;
  supports(check: VerificationCheck, artifact: Artifact): boolean;
  execute(artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult>;
}
