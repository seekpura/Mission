import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class IntegrationCheckExecutor implements VerificationCheckExecutor {
  id = "deterministic-integration-checks";
  supports(check: VerificationCheck): boolean {
    return check.method === "integration" && check.config?.integration?.mode === "artifacts-present";
  }

  async execute(_artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const required = check.config!.integration!.artifactLogicalNames;
    const artifacts = context.artifacts ?? [];
    const present = new Set(artifacts.filter(artifact => !["working", "invalid", "superseded"].includes(artifact.status)).map(artifact => artifact.logicalName));
    const missing = required.filter(name => !present.has(name));
    return checkResult(check, missing.length === 0 ? "pass" : "fail", missing.length === 0
      ? `Required integration artifacts are present: ${required.join(", ")}`
      : `Missing integration artifacts: ${missing.join(", ")}`);
  }
}

function checkResult(check: VerificationCheck, status: VerificationCheckResult["status"], detail: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
