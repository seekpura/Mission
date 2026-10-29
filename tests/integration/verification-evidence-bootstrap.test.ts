import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionMissionRuntimeFromEnv } from "../../src/runtime/bootstrap.ts";
import { STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL } from "../../src/runtime/provider-evidence-collector.ts";

function validBinding() {
  return {
    id: "browser-runtime",
    capabilityId: "browser.inspect",
    evidenceKind: "browser-runtime",
    evidenceType: "runtime-check",
    profileKinds: ["website"],
    artifactTypes: ["website"],
    expectedFunction: "verification.browser.inspect",
    readOnly: true,
    allowedPermissions: ["browser-read"],
    allowMetered: false,
    maxMonetaryClass: "low",
    claim: "Configured browser capability observed website runtime behavior."
  };
}

function validProviderRoute() {
  return {
    id: "browser-provider",
    capabilityId: "browser.inspect.prod",
    provider: "browser-provider",
    protocol: STRUCTURED_PROVIDER_EVIDENCE_PROTOCOL,
    nativeId: "browser-inspector-v3",
    evidenceKind: "browser-runtime",
    readOnly: true,
    allowedPermissions: ["browser-read"],
    allowMetered: false,
    maxMonetaryClass: "low"
  };
}

test("production bootstrap validates host Evidence binding JSON before any provider invocation", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-evidence-bootstrap-"));
  try {
    assert.throws(
      () => createProductionMissionRuntimeFromEnv({
        MISSION_HOME: join(root, "invalid-json"),
        MISSION_HOST_EVIDENCE_BINDINGS_JSON: "{not-json"
      }, process.cwd()),
      /MISSION_HOST_EVIDENCE_BINDINGS_JSON must be valid JSON/
    );

    assert.throws(
      () => createProductionMissionRuntimeFromEnv({
        MISSION_HOME: join(root, "not-read-only"),
        MISSION_HOST_EVIDENCE_BINDINGS_JSON: JSON.stringify([{ ...validBinding(), readOnly: false }])
      }, process.cwd()),
      /readOnly=true/
    );

    const runtime = createProductionMissionRuntimeFromEnv({
      MISSION_HOME: join(root, "valid"),
      MISSION_HOST_EVIDENCE_BINDINGS_JSON: JSON.stringify([validBinding()])
    }, process.cwd());
    runtime.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("production bootstrap validates structured provider routes and never fabricates a missing host capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-provider-evidence-bootstrap-"));
  try {
    assert.throws(
      () => createProductionMissionRuntimeFromEnv({
        MISSION_HOME: join(root, "invalid-provider-json"),
        MISSION_EVIDENCE_PROVIDER_ROUTES_JSON: "{not-json"
      }, process.cwd()),
      /MISSION_EVIDENCE_PROVIDER_ROUTES_JSON must be valid JSON/
    );

    assert.throws(
      () => createProductionMissionRuntimeFromEnv({
        MISSION_HOME: join(root, "invalid-provider-protocol"),
        MISSION_EVIDENCE_PROVIDER_ROUTES_JSON: JSON.stringify([
          { ...validProviderRoute(), protocol: "vendor-untyped/v1" }
        ])
      }, process.cwd()),
      /protocol must be mission-evidence\/v1/
    );

    const runtime = createProductionMissionRuntimeFromEnv({
      MISSION_HOME: join(root, "valid-provider-route"),
      MISSION_EVIDENCE_PROVIDER_ROUTES_JSON: JSON.stringify([validProviderRoute()])
    }, process.cwd());
    try {
      const snapshot = await runtime.host.snapshotEnvironment();
      assert.equal(
        snapshot.capabilities.some(capability => capability.id === "browser.inspect.prod"),
        false,
        "configuration may bind a real host capability but must never synthesize one into the HostAdapter"
      );
    } finally {
      runtime.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
