import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationResult } from "../domain/verification.ts";
import type { Verifier } from "./verifier.ts";

export class BasicFileVerifier implements Verifier {
  id = "basic-file-verifier";

  async verify(artifact: Artifact): Promise<VerificationResult> {
    const exists = existsSync(artifact.uri);
    const nonEmpty = exists && statSync(artifact.uri).size > 0;
    const pass = exists && nonEmpty;
    return {
      id: randomUUID(),
      missionId: artifact.missionId,
      artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: "basic-file",
      verifierId: this.id,
      level: "structural",
      overall: pass ? "pass" : "fail",
      checkResults: [
        { id: "file-exists", status: exists ? "pass" : "fail", evidenceRefs: [] },
        { id: "file-non-empty", status: nonEmpty ? "pass" : "fail", evidenceRefs: [] }
      ],
      findingRefs: [],
      evidenceRefs: [],
      createdAt: new Date().toISOString()
    };
  }
}
