import { createHash } from "node:crypto";
import type { Finding } from "../domain/verification.ts";

export function normalizeFinding(finding: Finding): Finding {
  const artifactFamily = artifactId(finding.artifactRef);
  const fingerprint = finding.fingerprint ?? digest(JSON.stringify({
    category: finding.category,
    checkId: finding.checkId ?? "",
    artifactFamily,
    observation: normalizeText(finding.observation),
    expected: normalizeText(finding.expected),
    requirementRefs: [...finding.requirementRefs].sort()
  }));
  return {
    ...finding,
    fingerprint,
    rootCauseKey: finding.rootCauseKey?.trim() || undefined,
    requirementRefs: [...new Set(finding.requirementRefs)].sort(),
    evidenceRefs: [...new Set(finding.evidenceRefs)].sort()
  };
}

export function findingClusterKey(finding: Finding): string {
  const normalized = normalizeFinding(finding);
  return normalized.rootCauseKey ? `root:${normalized.rootCauseKey}` : `fingerprint:${normalized.fingerprint}`;
}

export function canonicalGapId(finding: Finding): string {
  return `gap-${digest(findingClusterKey(finding)).slice(0, 20)}`;
}

function artifactId(ref?: string): string {
  if (!ref) return "";
  const split = ref.lastIndexOf("@");
  return split > 0 ? ref.slice(0, split) : ref;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(?:slide|page|frame|row|line)\s*#?\d+\b/g, "$1")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
