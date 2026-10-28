import test from "node:test";
import assert from "node:assert/strict";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import { VerificationProfileRegistry, createDefaultVerificationProfileRegistry } from "../../src/core/verification/verification-profile.ts";

function artifact(overrides: Partial<Artifact>): Artifact {
  return {
    id: "a1",
    missionId: "m1",
    logicalName: "output",
    type: "file",
    version: 1,
    status: "candidate",
    uri: "/tmp/output.bin",
    contentHash: "sha256:deadbeef",
    producedByAttemptId: "attempt-1",
    sourceArtifactRefs: [],
    createdAt: "2026-10-29T00:00:00.000Z",
    ...overrides
  };
}

test("verification profile selection prefers explicit artifact type", () => {
  const registry = createDefaultVerificationProfileRegistry();
  const selected = registry.select(artifact({ type: "presentation", uri: "/tmp/output.html", mimeType: "text/html" }));
  assert.equal(selected.profile.id, "presentation-mission-review-v1");
  assert.equal(selected.reason, "artifact-type");
});

test("verification profile selection can classify generic file by mime type", () => {
  const registry = createDefaultVerificationProfileRegistry();
  const selected = registry.select(artifact({ type: "file", uri: "/tmp/output.bin", mimeType: "video/mp4" }));
  assert.equal(selected.profile.id, "video-mission-review-v1");
  assert.equal(selected.reason, "mime-type");
});

test("verification profile selection falls back to extension when type and mime are generic", () => {
  const registry = createDefaultVerificationProfileRegistry();
  const selected = registry.select(artifact({ type: "file", uri: "/tmp/index.html", mimeType: undefined }));
  assert.equal(selected.profile.id, "website-mission-review-v1");
  assert.equal(selected.reason, "extension");
});

test("verification profile selection keeps research explicit instead of guessing from markdown", () => {
  const registry = createDefaultVerificationProfileRegistry();
  assert.equal(registry.select(artifact({ type: "research", uri: "/tmp/report.md" })).profile.id, "research-mission-review-v1");
  assert.equal(registry.select(artifact({ type: "document", uri: "/tmp/report.md" })).profile.id, "generic-mission-review-v1");
});

test("registry rejects duplicate profile ids and missing generic fallback", () => {
  const generic = {
    id: "same",
    kind: "generic" as const,
    title: "generic",
    artifactTypes: ["file" as const],
    checks: [],
    evidenceRequirements: [],
    instructions: []
  };
  assert.throws(() => new VerificationProfileRegistry([generic, { ...generic }]), /Duplicate verification profile id/);
  assert.throws(
    () => new VerificationProfileRegistry([{ ...generic, id: "code", kind: "code", artifactTypes: ["code"] }]),
    /generic fallback/
  );
});
