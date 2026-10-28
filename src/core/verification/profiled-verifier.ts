import { randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationResult, VerificationCheckResult } from "../domain/verification.ts";
import type { Verifier, VerificationContext } from "./verifier.ts";
import { VerificationPlanner } from "./verification-planner.ts";
import { VerifierRegistry } from "./verifier-registry.ts";

export class ProfiledVerifier implements Verifier {
  id = "profiled-verifier";
  private readonly planner: VerificationPlanner;
  private readonly registry: VerifierRegistry;
  constructor(planner: VerificationPlanner, registry: VerifierRegistry) { this.planner = planner; this.registry = registry; }

  async verify(artifact: Artifact, context: VerificationContext = {}): Promise<VerificationResult> {
    const profile = this.planner.plan(artifact, context);
    const results: VerificationCheckResult[] = [];
    for (const check of profile.checks) {
      const executor = this.registry.resolve(check, artifact);
      if (!executor) {
        results.push({ id: check.id, status: "inconclusive", detail: `No verifier is available for required method: ${check.method}`, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs });
        continue;
      }
      results.push(await executor.execute(artifact, check, { missionId: artifact.missionId }));
    }
    const required = results.filter(result => result.priority !== "preferred");
    const hasFail = required.some(result => result.status === "fail");
    const hasInconclusive = required.some(result => result.status === "inconclusive");
    const hasWarning = results.some(result => result.status === "warning" || (result.priority === "preferred" && result.status !== "pass"));
    return {
      id: randomUUID(), missionId: artifact.missionId, artifactRef: `${artifact.id}@${artifact.version}`,
      verificationProfileId: profile.id, verifierId: this.id,
      level: highestLevel(profile.checks.map(check => check.level)),
      overall: hasFail ? "fail" : hasInconclusive ? "inconclusive" : hasWarning ? "pass_with_warnings" : "pass",
      checkResults: results, findingRefs: [], evidenceRefs: [], createdAt: new Date().toISOString()
    };
  }
}

function highestLevel(levels: Array<"structural" | "functional" | "quality" | "integration" | "mission">) {
  const order = ["structural", "functional", "quality", "integration", "mission"] as const;
  return order[Math.max(0, ...levels.map(level => order.indexOf(level)))]!;
}
