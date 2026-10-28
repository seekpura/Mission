import type { Artifact } from "../domain/artifact.ts";
import type { InspectionOutcome } from "../domain/inspection.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { VerificationProfile, VerificationResult } from "../domain/verification.ts";

export interface VerificationContext {
  acceptanceContract?: AcceptanceContract | null;
  requirements?: Requirement[];
  explicitRequirementRefs?: string[];
  artifacts?: Artifact[];
  priorVerifications?: VerificationResult[];
  inspection?: InspectionOutcome;
}

export interface Verifier {
  id: string;
  plan?(artifact: Artifact, context?: VerificationContext): VerificationProfile;
  verify(artifact: Artifact, context?: VerificationContext): Promise<VerificationResult>;
}
