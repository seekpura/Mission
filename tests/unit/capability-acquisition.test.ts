import test from "node:test";
import assert from "node:assert/strict";
import { GitHubCapabilityDiscoveryProvider } from "../../src/core/capabilities/providers/github-provider.ts";
import { CandidateRanker } from "../../src/core/capabilities/candidate-ranker.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";

test("GitHub discovery is need-driven and candidate ranking prefers matching repository", async () => {
  const provider = new GitHubCapabilityDiscoveryProvider({
    async searchRepositories(query) {
      assert.match(query, /animation/);
      return [
        { fullName: "x/irrelevant-db", url: "https://github.com/x/db", description: "database migration" },
        { fullName: "x/diagram-animation-cli", url: "https://github.com/x/motion", description: "technical diagram animation mp4 cli" }
      ];
    }
  });
  const need: any = { id: "n1", missionId: "m", objective: "technical motion", requiredFunctions: ["technical diagram animation"], desiredInputs: ["svg"], desiredOutputs: ["mp4"], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: [], gapRefs: [] };
  const candidates = await provider.discover(need);
  const ranked = new CandidateRanker().rank(need, candidates);
  assert.match(ranked[0]!.candidate.name, /diagram-animation/);
});

test("mission overlay does not mutate host capability list", () => {
  const host: any[] = [{ id: "research", kind: "skill", name: "Research", description: "research", hostNative: true, available: true, permissions: [], scope: "host" }];
  const overlay = new MissionCapabilityOverlay();
  overlay.activate("m", { id: "motion", kind: "cli", name: "Motion", description: "animation", hostNative: false, available: true, permissions: [], scope: "mission" });
  assert.equal(host.length, 1);
  assert.deepEqual(overlay.effective("m", host).map(x => x.id).sort(), ["motion", "research"]);
});
