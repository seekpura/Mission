import type { Artifact } from "../domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { VerificationResult } from "../domain/verification.ts";

export interface VerificationContext {
  acceptanceContract?: AcceptanceContract | null;
  requirements?: Requirement[];
  explicitRequirementRefs?: string[];
  artifacts?: Artifact[];
  priorVerifications?: VerificationResult[];
}

export interface Verifier {
  id: string;
  verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult>;
}
