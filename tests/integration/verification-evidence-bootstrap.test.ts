import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProductionMissionRuntimeFromEnv } from "../../src/runtime/bootstrap.ts";

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
