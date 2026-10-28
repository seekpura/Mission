import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import { CapabilitySmokeTester } from "../../src/core/capabilities/sandbox/smoke-tester.ts";
import { SecureAcquisitionService } from "../../src/core/capabilities/secure-acquisition-service.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";

function createSkillRepo(root: string) {
  const repo = join(root, "skill-source");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "SKILL.md"), "# Fixture Skill\nUse this skill for special rendering.\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "SKILL.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return { repo, sha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

test("secure acquisition pins a Git candidate, structurally smokes an instruction skill and activates a mission-local immutable copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-"));
  const fixture = createSkillRepo(root);
  const overlay = new MissionCapabilityOverlay();
  const service = new SecureAcquisitionService({
    providers: [{ id: "fixture", async discover() { return [{ id: "candidate-1", sourceType: "github", sourceUri: fixture.repo, name: "fixture/special-render", description: "special rendering skill", candidateKind: "skill", status: "discovered" }]; } }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))),
    overlay,
    activationRoot: join(root, "mission-capabilities")
  });
  const traces: string[] = [];
  const outcome = await service.acquire({
    id: "need-1", missionId: "m1", objective: "special rendering", requiredFunctions: ["special rendering"], desiredInputs: [], desiredOutputs: [], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: [], gapRefs: [], status: "discovering"
  }, { onTrace(type) { traces.push(type); } });

  assert.ok(outcome.capability);
  assert.equal(outcome.capability.revision, fixture.sha);
  assert.match(outcome.capability.contentHash!, /^[0-9a-f]{64}$/);
  assert.equal(outcome.receipt.status, "activated");
  assert.equal(overlay.list("m1").length, 1);
  assert.ok(existsSync(outcome.capability.invocationRef!));
  assert.match(outcome.capability.invocationRef!, /SKILL\.md$/);
  assert.deepEqual(traces, [
    "capability.candidate.discovered",
    "capability.candidate.materialized",
    "capability.candidate.scanned",
    "capability.candidate.sandboxed",
    "capability.activated",
    "capability.acquisition.receipt"
  ]);
});
