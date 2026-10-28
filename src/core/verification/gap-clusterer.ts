import type { Finding, Gap } from "../domain/verification.ts";
import { canonicalGapId, findingClusterKey, normalizeFinding } from "./finding-normalizer.ts";

export interface GapSeed {
  category?: Gap["category"];
  severity?: Gap["severity"];
  description?: string;
  artifactRefs?: string[];
  requirementRefs?: string[];
}

export class GapClusterer {
  find(finding: Finding, gaps: Gap[]): Gap | undefined {
    const normalized = normalizeFinding(finding);
    const key = findingClusterKey(normalized);
    return gaps.find(gap => gapClusterKey(gap) === key);
  }

  create(finding: Finding, seed: GapSeed = {}): Gap {
    const normalized = normalizeFinding(finding);
    const artifactRefs = unique([...(seed.artifactRefs ?? []), ...(normalized.artifactRef ? [normalized.artifactRef] : [])]);
    const requirementRefs = unique([...(seed.requirementRefs ?? []), ...normalized.requirementRefs]);
    return {
      id: canonicalGapId(normalized),
      missionId: normalized.missionId,
      category: seed.category ?? gapCategory(normalized),
      severity: seed.severity ?? gapSeverity(normalized),
      description: seed.description ?? normalized.observation,
      findingRefs: [normalized.id],
      requirementRefs,
      artifactRefs,
      status: "open",
      fingerprint: normalized.fingerprint,
      rootCauseKey: normalized.rootCauseKey,
      occurrenceCount: 1,
      lastObservedAt: normalized.createdAt,
      openedAt: normalized.createdAt
    };
  }

  merge(gap: Gap, finding: Finding, seed: GapSeed = {}): Gap {
    const normalized = normalizeFinding(finding);
    const findingRefs = unique([...gap.findingRefs, normalized.id]);
    const nextSeverity = maxSeverity(gap.severity, seed.severity ?? gapSeverity(normalized));
    const artifactRefs = unique([
      ...gap.artifactRefs,
      ...(seed.artifactRefs ?? []),
      ...(normalized.artifactRef ? [normalized.artifactRef] : [])
    ]);
    const requirementRefs = unique([...gap.requirementRefs, ...(seed.requirementRefs ?? []), ...normalized.requirementRefs]);
    return {
      ...gap,
      category: seed.category ?? gap.category,
      severity: nextSeverity,
      description: gap.description || seed.description || normalized.observation,
      findingRefs,
      requirementRefs,
      artifactRefs,
      fingerprint: gap.fingerprint ?? normalized.fingerprint,
      rootCauseKey: gap.rootCauseKey ?? normalized.rootCauseKey,
      occurrenceCount: findingRefs.length,
      lastObservedAt: normalized.createdAt
    };
  }
}

export function gapClusterKey(gap: Gap): string {
  return gap.rootCauseKey ? `root:${gap.rootCauseKey}` : `fingerprint:${gap.fingerprint ?? gap.id}`;
}

function gapCategory(finding: Finding): Gap["category"] {
  if (finding.category === "integration") return "integration";
  if (finding.category === "evidence") return "evidence";
  if (finding.category === "constraint") return "constraint";
  return "quality";
}

function gapSeverity(finding: Finding): Gap["severity"] {
  if (finding.severity === "critical") return "critical";
  if (finding.severity === "major") return "major";
  return "minor";
}

function maxSeverity(a: Gap["severity"], b: Gap["severity"]): Gap["severity"] {
  const rank: Record<Gap["severity"], number> = { minor: 1, major: 2, critical: 3 };
  return rank[a] >= rank[b] ? a : b;
}

function unique(values: string[]): string[] { return [...new Set(values)]; }
