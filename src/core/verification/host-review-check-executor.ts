import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";

export class HostReviewCheckExecutor implements VerificationCheckExecutor {
  id = "independent-host-reviewer";
  cacheVersion = "2";
  private readonly host: HostAdapter;
  constructor(host: HostAdapter) { this.host = host; }
  supports(check: VerificationCheck): boolean { return ["semantic", "perceptual", "source"].includes(check.method); }

  async execute(artifact: Artifact, check: VerificationCheck, context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    if (check.method === "perceptual" && requiresDerivedInspection(artifact)) {
      const inspection = context.inspection;
      if (!inspection?.required || inspection.missingKinds.length > 0 || inspection.artifacts.length === 0) {
        const missing = inspection?.missingKinds.length ? ` Missing inspection kinds: ${inspection.missingKinds.join(", ")}.` : "";
        return result(check, "inconclusive", `Perceptual verification requires derived observable inspection artifacts for ${artifact.type}.${missing}`);
      }
    }
    const inspectionArtifacts = check.method === "perceptual"
      ? (context.inspection?.artifacts ?? []).map(item => ({
          id: item.id,
          version: item.version,
          type: item.type,
          uri: item.uri,
          logicalName: item.logicalName,
          contentHash: item.contentHash,
          sourceArtifactRefs: item.sourceArtifactRefs
        }))
      : [];
    const handle = await this.host.createAgent({
      missionId: context.missionId,
      workItemId: `verify:${artifact.id}:${check.id}`,
      workspaceRoot: undefined,
      allowedCapabilityRefs: [],
      context: {
        kind: "verification-review",
        independence: "You are an independent verifier. Do not assume the producer's claims are correct.",
        artifact: { id: artifact.id, version: artifact.version, type: artifact.type, uri: artifact.uri, logicalName: artifact.logicalName },
        inspectionArtifacts,
        check,
        responseContract: { status: "pass|fail|inconclusive", detail: "specific observation", confidence: "0..1" }
      }
    });
    let payload: unknown;
    for await (const event of this.host.observeAgent(handle)) {
      if (event.type === "failed") return result(check, "inconclusive", `Independent reviewer failed: ${extractError(event.payload)}`);
      if (event.type === "completed") payload = event.payload;
    }
    const verdict = parseVerdict(payload);
    if (!verdict) return result(check, "inconclusive", "Independent reviewer did not return a valid verification verdict");
    return result(check, verdict.status, verdict.detail);
  }
}

function requiresDerivedInspection(artifact: Artifact): boolean {
  return ["presentation", "document", "website", "video"].includes(artifact.type);
}

function parseVerdict(value: unknown): { status: "pass" | "fail" | "inconclusive"; detail?: string } | null {
  let candidate: any = value;
  if (typeof value === "string") {
    try { candidate = JSON.parse(value); } catch { return null; }
  }
  if (candidate && typeof candidate === "object" && typeof candidate.text === "string") {
    try { candidate = JSON.parse(candidate.text); } catch { return null; }
  }
  if (!candidate || typeof candidate !== "object" || !["pass", "fail", "inconclusive"].includes(candidate.status)) return null;
  return { status: candidate.status, detail: typeof candidate.detail === "string" ? candidate.detail : undefined };
}
function extractError(value: unknown): string { return value && typeof value === "object" && typeof (value as any).error === "string" ? (value as any).error : String(value); }
function result(check: VerificationCheck, status: VerificationCheckResult["status"], detail?: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
