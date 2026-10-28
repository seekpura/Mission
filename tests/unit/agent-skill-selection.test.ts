import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";

test("Git materializer selects the requested Agent Skill from a multi-skill repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-multiskill-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  mkdirSync(join(repo, "skills", "beta"), { recursive: true });
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\nAlpha\n");
  writeFileSync(join(repo, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\nBeta\n");
  const pm = new ProcessManager();
  for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Mission Test"], ["add", "."], ["commit", "-m", "fixture"]]) {
    const result = await pm.run({ command: "git", args, cwd: repo, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const materializer = new GitCandidateMaterializer(join(root, "quarantine"));
  const materialized = await materializer.materialize({
    id: "candidate-beta",
    sourceType: "agent-skill",
    sourceUri: repo,
    name: "beta",
    candidateKind: "skill",
    status: "discovered",
    metadata: { skillName: "beta" }
  });
  assert.equal(relative(materialized.root, join(materialized.root, "SKILL.md")), "SKILL.md");
  assert.match(materialized.root, /beta$/);
  assert.equal(materialized.candidate.metadata?.selectedSkillRoot, join("skills", "beta"));
});
