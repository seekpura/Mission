import type { CapabilityCandidate, CapabilityNeed } from "../domain/capability.ts";

export interface RankedCandidate {
  candidate: CapabilityCandidate;
  score: number;
  reasons: string[];
}

export class CandidateRanker {
  rank(need: CapabilityNeed, candidates: CapabilityCandidate[]): RankedCandidate[] {
    const needTokens = new Set(tokenize(`${need.objective} ${need.requiredFunctions.join(" ")} ${need.desiredOutputs.join(" ")}`));
    return candidates.map(candidate => {
      const text = `${candidate.name} ${candidate.description ?? ""}`;
      const tokens = new Set(tokenize(text));
      let overlap = 0;
      for (const token of needTokens) if (tokens.has(token)) overlap++;
      const kindBonus = candidate.candidateKind === "skill" || candidate.candidateKind === "mcp" || candidate.candidateKind === "cli" ? 1 : 0;
      const score = overlap * 10 + kindBonus;
      return { candidate, score, reasons: [`semantic-overlap:${overlap}`, `kind:${candidate.candidateKind}`] };
    }).sort((a, b) => b.score - a.score);
  }
}

function tokenize(input: string) { return input.toLowerCase().split(/[^a-z0-9]+/).filter(x => x.length > 2); }
