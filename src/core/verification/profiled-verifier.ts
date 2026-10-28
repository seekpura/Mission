import { createHash, randomUUID } from "node:crypto";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult, VerificationResult } from "../domain/verification.ts";
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
    let reusedCheckCount = 0;
    for (const check of profile.checks) {
      const executor = this.registry.resolve(check, artifact);
      const cacheKey = checkCacheKey(artifact, check, this.registry.identity(check, artifact), context.artifacts ?? []);
      const cached = reusableCheck(context.priorVerifications ?? [], cacheKey, check);
      if (cached) {
        results.push({ ...cached.result, cacheKey, reusedFromVerificationId: cached.verificationId });
        reusedCheckCount += 1;
        continue;
      }
      if (!executor) {
        results.push({ id: check.id, status: "inconclusive", detail: `No verifier is available for required method: ${check.method}`, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs, cacheKey });
        continue;
      }
      const executed = await executor.execute(artifact, check, { missionId: artifact.missionId, artifacts: context.artifacts });
      results.push({ ...executed, cacheKey });
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
      checkResults: results, findingRefs: [], evidenceRefs: [],
      cacheKey: digest(results.map(result => `${result.cacheKey ?? ""}:${result.status}`).sort().join("|")),
      reusedCheckCount,
      createdAt: new Date().toISOString()
    };
  }
}

function reusableCheck(prior: VerificationResult[], cacheKey: string, check: VerificationCheck): { verificationId: string; result: VerificationCheckResult } | null {
  if (check.method === "runtime" || check.method === "human") return null;
  const ordered = [...prior].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const verification of ordered) {
    const result = verification.checkResults.find(item => item.cacheKey === cacheKey && (item.status === "pass" || item.status === "warning"));
    if (result) return { verificationId: verification.id, result };
  }
  return null;
}

function checkCacheKey(artifact: Artifact, check: VerificationCheck, executorIdentity: string, artifacts: Artifact[]): string {
  const dependencies = integrationDependencies(check, artifacts);
  return digest(JSON.stringify({
    artifactHash: artifact.contentHash,
    check: {
      id: check.id,
      description: check.description,
      category: check.category,
      level: check.level,
      method: check.method,
      priority: check.priority,
      requirementRefs: [...check.requirementRefs].sort(),
      config: check.config ?? null
    },
    executorIdentity,
    dependencies
  }));
}

function integrationDependencies(check: VerificationCheck, artifacts: Artifact[]): Array<{ logicalName: string; contentHash: string; status: string }> {
  const names = check.config?.integration?.artifactLogicalNames ?? [];
  if (names.length === 0) return [];
  return names.sort().map(logicalName => {
    const candidates = artifacts
      .filter(item => item.logicalName === logicalName && !["working", "invalid", "superseded"].includes(item.status))
      .sort((a, b) => b.version - a.version);
    const selected = candidates[0];
    return { logicalName, contentHash: selected?.contentHash ?? "missing", status: selected?.status ?? "missing" };
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function highestLevel(levels: Array<"structural" | "functional" | "quality" | "integration" | "mission">) {
  const order = ["structural", "functional", "quality", "integration", "mission"] as const;
  return order[Math.max(0, ...levels.map(level => order.indexOf(level)))]!;
}
