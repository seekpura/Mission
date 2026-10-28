import type {
  CapabilityCostClass,
  CapabilityDescriptor,
  CapabilityNeed
} from "../domain/capability.ts";
import {
  buildHostCapabilityGraph,
  capabilityDescriptors,
  capabilityNode,
  environmentAvailability,
  requiredCapabilityRefs,
  routedExecutorIds,
  type HostCapabilityGraph
} from "./capability-graph.ts";

export interface CapabilityMatch {
  capabilityId: string;
  score: number;
  functionCoverage: number;
  inputCoverage: number;
  outputCoverage: number;
  routeExecutorIds: string[];
  reasons: string[];
}

export interface CapabilityResolution {
  status: "resolved" | "missing";
  capability?: CapabilityDescriptor;
  reason: string;
  graphRevision?: number;
  rankedMatches?: CapabilityMatch[];
}

const COST_ORDER: Record<CapabilityCostClass, number> = {
  negligible: 0,
  low: 1,
  medium: 2,
  high: 3,
  unknown: 4
};

export class CapabilityResolver {
  resolve(need: CapabilityNeed, source: CapabilityDescriptor[] | HostCapabilityGraph): CapabilityResolution {
    const graph = Array.isArray(source)
      ? buildHostCapabilityGraph({
          revision: 0,
          host: { type: "legacy-flat-capability-source" },
          capabilities: source
        })
      : source;

    const matches: Array<{ capability: CapabilityDescriptor; match: CapabilityMatch }> = [];
    const rejected: string[] = [];
    for (const capability of capabilityDescriptors(graph).filter(candidate => candidate.available)) {
      const eligibility = eligible(capability, need, graph);
      if (!eligibility.ok) {
        rejected.push(`${capability.id}: ${eligibility.reason}`);
        continue;
      }

      const functions = capability.functions?.length
        ? capability.functions
        : [`${capability.name} ${capability.description}`];
      const required = need.requiredFunctions.map(requiredFunction =>
        bestSemanticScore(requiredFunction, functions, capability.functions?.length ? "explicit" : "fallback")
      );
      if (required.some(score => score <= 0)) {
        const missed = need.requiredFunctions.filter((_, index) => required[index] <= 0);
        rejected.push(`${capability.id}: missing required function semantics (${missed.join(" | ")})`);
        continue;
      }

      const inputCoverage = coverage(need.desiredInputs, capability.accepts ?? []);
      const outputCoverage = coverage(need.desiredOutputs, capability.produces ?? []);
      const functionCoverage = required.length === 0 ? 1 : required.filter(score => score > 0).length / required.length;
      const semanticScore = required.reduce((sum, score) => sum + score, 0);
      const explicitBonus = capability.functions?.length ? 1 : 0;
      const ioScore = inputCoverage * 1.5 + outputCoverage * 1.5;
      const nativeBonus = capability.hostNative ? 0.25 : 0;
      const permissionPenalty = Math.min(0.5, capability.permissions.length * 0.02);
      const costAdjustment = costScore(capability);
      const score = semanticScore + explicitBonus + ioScore + nativeBonus + costAdjustment - permissionPenalty;
      const reasons = [
        capability.functions?.length ? "explicit semantic functions matched" : "fallback text semantics matched",
        ...(need.desiredInputs.length ? [`input coverage ${formatCoverage(inputCoverage)}`] : []),
        ...(need.desiredOutputs.length ? [`output coverage ${formatCoverage(outputCoverage)}`] : []),
        ...(capability.constraints?.requiredEnvironment?.length
          ? [`environment constraints satisfied: ${capability.constraints.requiredEnvironment.join(", ")}`]
          : []),
        ...(requiredCapabilityRefs(graph, capability.id).length
          ? [`dependency constraints satisfied: ${requiredCapabilityRefs(graph, capability.id).join(", ")}`]
          : []),
        ...(need.policy ? ["CapabilityNeed policy constraints satisfied"] : [])
      ];
      matches.push({
        capability,
        match: {
          capabilityId: capability.id,
          score,
          functionCoverage,
          inputCoverage,
          outputCoverage,
          routeExecutorIds: routedExecutorIds(graph, capability.id),
          reasons
        }
      });
    }

    matches.sort((a, b) =>
      b.match.score - a.match.score ||
      a.capability.permissions.length - b.capability.permissions.length ||
      a.capability.id.localeCompare(b.capability.id)
    );
    const rankedMatches = matches.map(item => item.match);
    const best = matches[0];
    if (!best) {
      const detail = rejected.length ? `; rejected: ${rejected.slice(0, 5).join(" | ")}` : "";
      return {
        status: "missing",
        reason: `No available capability satisfies required functions, graph constraints and CapabilityNeed policy${detail}`,
        graphRevision: graph.revision,
        rankedMatches
      };
    }
    return {
      status: "resolved",
      capability: best.capability,
      reason: `Selected ${best.capability.id} from capability graph at score ${best.match.score.toFixed(2)} (${best.match.reasons.join("; ")})`,
      graphRevision: graph.revision,
      rankedMatches
    };
  }
}

function eligible(
  capability: CapabilityDescriptor,
  need: CapabilityNeed,
  graph: HostCapabilityGraph
): { ok: true } | { ok: false; reason: string } {
  const purposes = capability.constraints?.supportedPurposes;
  if (purposes?.length && !purposes.includes(need.purpose)) {
    return { ok: false, reason: `purpose ${need.purpose} is not supported` };
  }

  for (const environment of capability.constraints?.requiredEnvironment ?? []) {
    const available = environmentAvailability(graph, environment);
    if (available !== true) {
      return {
        ok: false,
        reason: `required environment ${environment} is ${available === false ? "unavailable" : "unknown"}`
      };
    }
  }

  for (const dependencyId of requiredCapabilityRefs(graph, capability.id)) {
    const dependency = capabilityNode(graph, dependencyId)?.capability;
    if (!dependency?.available) return { ok: false, reason: `required capability ${dependencyId} is unavailable` };
  }

  const policy = need.policy;
  if (!policy) return { ok: true };

  if (policy.acceptableKinds?.length && !policy.acceptableKinds.includes(capability.kind)) {
    return { ok: false, reason: `kind ${capability.kind} is outside acceptableKinds` };
  }

  if (policy.requiredExecutionModes?.length) {
    const mode = capability.routing?.executionMode;
    if (!mode || !policy.requiredExecutionModes.includes(mode)) {
      return { ok: false, reason: `execution mode ${mode ?? "unknown"} does not satisfy requiredExecutionModes` };
    }
  }

  const forbidden = (policy.forbiddenPermissions ?? []).filter(permission => capability.permissions.includes(permission));
  if (forbidden.length > 0) {
    return { ok: false, reason: `forbidden permissions: ${forbidden.join(", ")}` };
  }

  if (policy.acceptableProviders?.length) {
    const provider = capability.native?.provider;
    if (!provider || !policy.acceptableProviders.includes(provider)) {
      return { ok: false, reason: `provider ${provider ?? "unknown"} is outside acceptableProviders` };
    }
  }

  if (policy.requiredNativeFeatures?.length) {
    const availableFeatures = new Set(capability.native?.features ?? []);
    const missing = policy.requiredNativeFeatures.filter(feature => !availableFeatures.has(feature));
    if (missing.length > 0) return { ok: false, reason: `missing native features: ${missing.join(", ")}` };
  }

  if (policy.acceptableProvenanceSources?.length) {
    const source = capability.provenance?.source;
    if (!source || !policy.acceptableProvenanceSources.includes(source)) {
      return { ok: false, reason: `provenance ${source ?? "unknown"} is outside acceptableProvenanceSources` };
    }
  }

  if (policy.maxMonetaryClass) {
    const actual = capability.cost?.monetaryClass ?? "unknown";
    if (actual === "unknown" || COST_ORDER[actual] > COST_ORDER[policy.maxMonetaryClass]) {
      return {
        ok: false,
        reason: `monetary cost ${actual} exceeds or cannot prove maxMonetaryClass ${policy.maxMonetaryClass}`
      };
    }
  }

  return { ok: true };
}

function bestSemanticScore(required: string, candidates: string[], mode: "explicit" | "fallback"): number {
  let best = 0;
  for (const candidate of candidates) {
    const left = canonicalText(required);
    const right = canonicalText(candidate);
    if (!left || !right) continue;
    if (left === right) best = Math.max(best, mode === "explicit" ? 5 : 3);
    else if (right.includes(left) || left.includes(right)) best = Math.max(best, mode === "explicit" ? 4 : 2.5);
    else {
      const requiredTokens = new Set(tokenize(left));
      const candidateTokens = new Set(tokenize(right));
      if (requiredTokens.size === 0) continue;
      const overlap = [...requiredTokens].filter(token => candidateTokens.has(token)).length / requiredTokens.size;
      if (overlap >= 0.5) best = Math.max(best, (mode === "explicit" ? 3 : 1.5) * overlap);
    }
  }
  return best;
}

function coverage(desired: string[], supported: string[]): number {
  if (desired.length === 0) return 1;
  if (supported.length === 0) return 0;
  const hits = desired.filter(item => bestSemanticScore(item, supported, "explicit") > 0).length;
  return hits / desired.length;
}

function costScore(capability: CapabilityDescriptor): number {
  switch (capability.cost?.monetaryClass) {
    case "negligible": return 0.3;
    case "low": return 0.2;
    case "medium": return 0;
    case "high": return -0.3;
    default: return 0;
  }
}

function canonicalText(input: string): string {
  return input.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function tokenize(input: string): string[] {
  const normalized = canonicalText(input);
  if (!normalized) return [];
  const output = new Set<string>();

  try {
    const segmenter = new Intl.Segmenter("und", { granularity: "word" });
    for (const segment of segmenter.segment(normalized)) {
      if (segment.isWordLike && segment.segment.trim()) output.add(segment.segment.trim());
    }
  } catch {
    // Node runtimes without Intl.Segmenter still use the Unicode fallback below.
  }

  for (const chunk of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
    output.add(chunk);
    if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(chunk)) {
      const characters = [...chunk];
      for (const character of characters) output.add(character);
      for (let index = 0; index + 1 < characters.length; index += 1) {
        output.add(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }
  return [...output];
}

function formatCoverage(value: number): string {
  return `${Math.round(value * 100)}%`;
}
