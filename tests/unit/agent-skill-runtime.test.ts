import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import {
  MissionAgentSkillWorkspaceProjector,
  parseAgentSkillMetadata
} from "../../src/runtime/agent-skill-runtime.ts";

test("Agent Skill metadata requires DSH-compatible YAML frontmatter", () => {
  assert.throws(
    () => parseAgentSkillMetadata("# No frontmatter\nDo something useful.\n"),
    /must begin with YAML frontmatter/
  );

  const metadata = parseAgentSkillMetadata([
    "---",
    "name: source-truth",
    "description: Verify source truth before producing output.",
    "---",
    "# Source Truth",
    ""
  ].join("\n"));
  assert.deepEqual(metadata, {
    name: "source-truth",
    description: "Verify source truth before producing output.",
    modelInvocable: true
  });
});

test("Agent Skill metadata preserves disable-model-invocation as a hard delivery signal", () => {
  const metadata = parseAgentSkillMetadata([
    "---",
    "name: manual-only",
    "description: A user-only skill that must not be offered to the model.",
    "disable-model-invocation: true",
    "---",
    "# Manual Only",
    ""
  ].join("\n"));
  assert.equal(metadata.modelInvocable, false);
});

test("workspace projection refuses a symlinked .agents root", { skip: process.platform === "win32" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-skill-projection-symlink-"));
  try {
    const bundle = join(root, "bundle");
    mkdirSync(bundle);
    writeFileSync(join(bundle, "SKILL.md"), [
      "---",
      "name: safe-skill",
      "description: A valid model-invocable skill.",
      "---",
      "# Safe Skill",
      ""
    ].join("\n"), "utf8");

    const overlay = new MissionCapabilityOverlay();
    overlay.activate("mission-skill-symlink", {
      id: "acquired:safe-skill",
      kind: "skill",
      name: "safe-skill",
      description: "A valid model-invocable skill.",
      hostNative: false,
      available: true,
      invocationRef: bundle,
      permissions: [],
      revision: "commit-1",
      scope: "mission"
    });

    const workspace = join(root, "workspace");
    const outside = join(root, "outside-agents");
    mkdirSync(workspace);
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, ".agents"), "dir");

    const projector = new MissionAgentSkillWorkspaceProjector(overlay);
    assert.throws(
      () => projector.project("mission-skill-symlink", ["acquired:safe-skill"], workspace),
      /Mission-owned directory is unsafe/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
