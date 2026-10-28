import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionMissionRuntimeFromEnv } from "../../src/runtime/bootstrap.ts";

test("production bootstrap refuses Agent Skill acquisition unless Docker strong isolation is explicitly selected", () => {
  assert.throws(
    () => createProductionMissionRuntimeFromEnv({
      MISSION_CAPABILITY_ACQUISITION: "github-skills"
    }, process.cwd()),
    /requires MISSION_CAPABILITY_ISOLATION=docker/
  );

  assert.throws(
    () => createProductionMissionRuntimeFromEnv({
      MISSION_CAPABILITY_ACQUISITION: "github-skills",
      MISSION_CAPABILITY_ISOLATION: "process"
    }, process.cwd()),
    /requires MISSION_CAPABILITY_ISOLATION=docker/
  );
});

test("production bootstrap rejects unknown acquisition modes instead of silently enabling a fallback", () => {
  assert.throws(
    () => createProductionMissionRuntimeFromEnv({
      MISSION_CAPABILITY_ACQUISITION: "auto-install-anything",
      MISSION_CAPABILITY_ISOLATION: "docker"
    }, process.cwd()),
    /Unsupported MISSION_CAPABILITY_ACQUISITION mode/
  );
});

test("production acquisition and lifecycle share the same trusted capability cache authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-bootstrap-cache-"));
  const runtime = createProductionMissionRuntimeFromEnv({
    MISSION_HOME: root,
    MISSION_CAPABILITY_ACQUISITION: "github-skills",
    MISSION_CAPABILITY_ISOLATION: "docker"
  }, process.cwd());

  try {
    await assert.rejects(
      () => runtime.capabilityLifecycle.revokeTrustedCache({
        missionId: "mission-cache-bootstrap",
        cacheKey: "a".repeat(64),
        reason: "prove production cache authority is wired"
      }),
      /Trusted capability cache entry not found/
    );
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});
