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

test("production bootstrap selects Codex app-server as a real HostAdapter without spawning it for environment discovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-codex-bootstrap-"));
  const runtime = createProductionMissionRuntimeFromEnv({
    MISSION_HOME: root,
    MISSION_HOST_KIND: "codex",
    MISSION_CODEX_BINARY: "codex-fixture-not-spawned",
    MISSION_CODEX_MODEL: "fixture-model"
  }, process.cwd());

  try {
    const descriptor = await runtime.host.describeHost();
    const environment = await runtime.host.snapshotEnvironment();
    assert.equal(descriptor.type, "openai-codex");
    assert.equal(environment.host.type, "openai-codex");
    const capability = environment.capabilities.find(item => item.id === "openai-codex.app-server-agent");
    assert(capability);
    assert.equal(capability.native?.protocol, "codex-app-server-jsonrpc-v2");
    assert.equal(capability.routing?.resumable, true);
    assert(capability.native?.features?.includes("turn-steer"));
  } finally {
    runtime.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production bootstrap rejects unknown host kinds and DeepSeek-native Skill delivery through Codex", () => {
  assert.throws(
    () => createProductionMissionRuntimeFromEnv({ MISSION_HOST_KIND: "mystery-host" }, process.cwd()),
    /Unsupported MISSION_HOST_KIND/
  );

  const root = mkdtempSync(join(tmpdir(), "mission-codex-skill-gate-"));
  try {
    assert.throws(
      () => createProductionMissionRuntimeFromEnv({
        MISSION_HOME: root,
        MISSION_HOST_KIND: "codex",
        MISSION_CAPABILITY_ACQUISITION: "github-skills",
        MISSION_CAPABILITY_ISOLATION: "docker"
      }, process.cwd()),
      /not yet deliverable through Codex app-server/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
