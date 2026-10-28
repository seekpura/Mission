import type { CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import {
  CAPABILITY_COST_ORDER,
  CAPABILITY_TRUST_ORDER,
  buildCapabilityGraph,
  missingCapabilityDependencies,
  type CapabilityGraphNode
} from "./capability-graph.ts";

export interface CapabilityMatchEvaluation {
  capabilityId: string;
  accepted: boolean;
  score: number;
  functionCoverage: number;
  reasons: string[];
}

export interface CapabilityResolution {
  status: "resolved" | "missing";
  capability?: CapabilityDescriptor;
  reason: string;
  score?: number;
  evaluated?: CapabilityMatchEvaluation[];
}

export class CapabilityResolver {
  resolve(need: CapabilityNeed, available: CapabilityDescriptor[]): CapabilityResolution {
    const graph = buildCapabilityGraph(available);
    const evaluated = [...graph.nodes.values()].map(node => evaluateCapability(need, node, graph));
    const accepted = evaluated
      .filter(evaluation => evaluation.accepted)
      .sort((left, right) => right.score - left.score || left.capabilityId.localeCompare(right.capabilityId));

    const best = accepted[0];
    if (!best) {
      return {
        status: "missing",
        reason: summarizeRejections(evaluated),
        evaluated
      };
    }
    const capability = graph.nodes.get(best.capabilityId)!.descriptor;
    return {
      status: "resolved",
      capability,
      reason: `Matched all ${need.requiredFunctions.length} required functions with semantic score ${best.score.toFixed(2)}`,
      score: best.score,
      evaluated
    };
  }
}

function evaluateCapability(
  need: CapabilityNeed,
  node: CapabilityGraphNode,
  graph: ReturnType<typeof buildCapabilityGraph>
): CapabilityMatchEvaluation {
  const reasons: string[] = [];
  const descriptor = node.descriptor;
  const semantics = node.semantics;

  if (!descriptor.available) reasons.push("capability is unavailable");
  if (need.acceptableKinds?.length && !need.acceptableKinds.includes(descriptor.kind)) {
    reasons.push(`kind ${descriptor.kind} is outside acceptableKinds`);
  }
  if (need.requiredDeliveryModes?.length &&
      !need.requiredDeliveryModes.some(mode => semantics.deliveryModes.includes(mode))) {
    reasons.push(`delivery modes ${semantics.deliveryModes.join(",") || "none"} do not satisfy requiredDeliveryModes`);
  }
  if (!semantics.purposes.includes(need.purpose)) {
    reasons.push(`purpose ${need.purpose} is unsupported`);
  }
  const forbidden = (need.forbiddenPermissions ?? []).filter(permission => descriptor.permissions.includes(permission));
  if (forbidden.length > 0) reasons.push(`forbidden permissions: ${forbidden.join(",")}`);
  if (need.acceptableTrust?.length && !need.acceptableTrust.includes(semantics.trust)) {
    reasons.push(`trust ${semantics.trust} is outside acceptableTrust`);
  }
  if (need.maxCostClass) {
    const actual = CAPABILITY_COST_ORDER[semantics.costClass];
    const maximum = CAPABILITY_COST_ORDER[need.maxCostClass];
    if (semantics.costClass === "unknown" || actual > maximum) {
      reasons.push(`cost ${semantics.costClass} exceeds or cannot prove maxCostClass ${need.maxCostClass}`);
    }
  }
  const missingDependencies = missingCapabilityDependencies(graph, node);
  if (missingDependencies.length > 0) reasons.push(`missing capability dependencies: ${missingDependencies.join(",")}`);

  const searchable = [descriptor.name, descriptor.description, ...semantics.functions];
  const functionMatches = need.requiredFunctions.map(required => matchPhrase(required, searchable));
  const matchedCount = functionMatches.filter(score => score > 0).length;
  const functionCoverage = need.requiredFunctions.length === 0 ? 1 : matchedCount / need.requiredFunctions.length;
  if (functionCoverage < 1) {
    const missed = need.requiredFunctions.filter((_, index) => functionMatches[index] === 0);
    reasons.push(`required functions not covered: ${missed.join(" | ")}`);
  }

  const accepted = reasons.length === 0;
  let score = functionMatches.reduce((sum, value) => sum + value * 10, 0);
  score += softMatchScore(need.desiredInputs, semantics.inputTypes) * 2;
  score += softMatchScore(need.desiredOutputs, semantics.outputTypes) * 3;
  score += semantics.deliveryModes.includes("unknown") ? 0 : 0.5;
  score += CAPABILITY_TRUST_ORDER[semantics.trust] * 0.1;
  if (!accepted) score = 0;

  return { capabilityId: descriptor.id, accepted, score, functionCoverage, reasons };
}

function matchPhrase(required: string, candidates: string[]): number {
  const wanted = normalize(required);
  if (!wanted) return 0;
  const normalizedCandidates = candidates.map(normalize).filter(Boolean);
  if (normalizedCandidates.some(candidate => candidate.includes(wanted) || (candidate.length >= 4 && wanted.includes(candidate)))) {
    return 1;
  }

  const wantedTokens = tokens(required);
  if (wantedTokens.size === 0) return 0;
  const candidateTokens = new Set(candidates.flatMap(candidate => [...tokens(candidate)]));
  let overlap = 0;
  for (const token of wantedTokens) if (candidateTokens.has(token)) overlap += 1;
  return overlap / wantedTokens.size;
}

function softMatchScore(desired: string[], actual: string[]): number {
  if (desired.length === 0 || actual.length === 0) return 0;
  let total = 0;
  for (const requirement of desired) total += matchPhrase(requirement, actual);
  return total / desired.length;
}

function tokens(input: string): Set<string> {
  const normalized = normalize(input);
  const output = new Set<string>();
  if (!normalized) return output;

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
      const chars = [...chunk];
      for (const char of chars) output.add(char);
      for (let index = 0; index + 1 < chars.length; index += 1) output.add(`${chars[index]}${chars[index + 1]}`);
    }
  }
  return output;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function summarizeRejections(evaluated: CapabilityMatchEvaluation[]): string {
  if (evaluated.length === 0) return "No capabilities are available in the effective capability graph";
  const details = evaluated
    .slice(0, 6)
    .map(item => `${item.capabilityId}: ${item.reasons.join("; ") || "not selected"}`)
    .join(" | ");
  return `No compatible capability satisfies all hard constraints and required functions. ${details}`;
}
