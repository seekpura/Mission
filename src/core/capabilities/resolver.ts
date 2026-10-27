import type { CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";

export interface CapabilityResolution {
  status: "resolved" | "missing";
  capability?: CapabilityDescriptor;
  reason: string;
}

export class CapabilityResolver {
  resolve(need: CapabilityNeed, available: CapabilityDescriptor[]): CapabilityResolution {
    const tokens = new Set(need.requiredFunctions.flatMap(x => tokenize(x)));
    let best: { cap: CapabilityDescriptor; score: number } | undefined;
    for (const cap of available.filter(c => c.available)) {
      const haystack = new Set(tokenize(`${cap.name} ${cap.description}`));
      let score = 0;
      for (const token of tokens) if (haystack.has(token)) score++;
      if (!best || score > best.score) best = { cap, score };
    }
    if (!best || best.score === 0) return { status: "missing", reason: "No available capability matches required functions" };
    return { status: "resolved", capability: best.cap, reason: `Matched ${best.score} capability terms` };
  }
}

function tokenize(input: string) {
  return input.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
