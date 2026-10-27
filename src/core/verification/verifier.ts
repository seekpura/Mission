import type { Artifact } from "../domain/artifact.ts";
import type { VerificationResult } from "../domain/verification.ts";

export interface Verifier {
  id: string;
  verify(artifact: Artifact): Promise<VerificationResult>;
}
