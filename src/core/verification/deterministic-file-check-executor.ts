import { existsSync, statSync } from "node:fs";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class DeterministicFileCheckExecutor implements VerificationCheckExecutor {
  id = "deterministic-file-checks";
  supports(check: VerificationCheck): boolean { return check.method === "deterministic" && check.level === "structural"; }
  async execute(artifact: Artifact, check: VerificationCheck, _context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const exists = existsSync(artifact.uri);
    const nonEmpty = exists && statSync(artifact.uri).size > 0;
    const pass = check.id === "file-exists" ? exists : nonEmpty;
    const detail = pass ? undefined : !exists ? "Artifact file does not exist" : "Artifact file is empty";
    return result(check, pass ? "pass" : "fail", detail);
  }
}

function result(check: VerificationCheck, status: VerificationCheckResult["status"], detail?: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
