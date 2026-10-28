import assert from "node:assert/strict";
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
