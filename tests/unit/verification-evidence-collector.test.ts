import assert from "node:assert/strict";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import {
  VerificationEvidenceCollectorRegistry,
  type VerificationEvidenceCollector
} from "../../src/core/verification/evidence-collector.ts";
import { createDefaultVerificationProfileRegistry } from "../../src/core/verification/verification-profile.ts";

const artifact: Artifact = {
  id: "artifact-collector",
  missionId: "mission-collector",
  logicalName: "fixture",
  type: "file",
  version: 1,
  status: "candidate",
  uri: "/tmp/fixture.txt",
  contentHash: `sha256:${"a".repeat(64)}`,
  producedByAttemptId: "attempt-1",
  sourceArtifactRefs: [],
  createdAt: "2026-10-29T00:00:00.000Z"
};

const profile = createDefaultVerificationProfileRegistry().select(artifact).profile;

test("collector registry isolates supports, synchronous and asynchronous adapter failures", async () => {
  const supportsFailure: VerificationEvidenceCollector = {
    id: "supports-failure",
    kinds: ["static-analysis"],
    supports() { throw new Error("supports exploded"); },
    collect: () => []
  };
  const synchronous: VerificationEvidenceCollector = {
    id: "sync-failure",
    kinds: ["browser-runtime"],
    supports: () => true,
    collect() { throw new Error("sync collector exploded"); }
  };
  const asynchronous: VerificationEvidenceCollector = {
    id: "async-failure",
    kinds: ["media-probe"],
    supports: () => true,
    async collect() { throw new Error("async collector exploded"); }
  };
  const healthy: VerificationEvidenceCollector = {
    id: "healthy",
    kinds: ["file-integrity"],
    supports: () => true,
    collect: () => [{
      type: "file-validation",
      kind: "file-integrity",
      claim: "healthy evidence",
      result: "supports"
    }]
  };

  const result = await new VerificationEvidenceCollectorRegistry([supportsFailure, synchronous, asynchronous, healthy]).collect({
    artifact,
    profile,
    maxInspectionBytes: 4096
  });

  assert.deepEqual(result.attemptedCollectorIds, ["supports-failure", "sync-failure", "async-failure", "healthy"]);
  assert.equal(result.collected.length, 1);
  assert.equal(result.collected[0]?.collectorId, "healthy");
  assert.deepEqual(
    result.failures.map(failure => failure.collectorId).sort(),
    ["async-failure", "supports-failure", "sync-failure"]
  );
  assert.match(result.failures.find(failure => failure.collectorId === "supports-failure")?.reason ?? "", /supports\(\) failed/);
  assert.match(result.failures.find(failure => failure.collectorId === "sync-failure")?.reason ?? "", /sync collector exploded/);
});

test("collector registry rejects duplicate ids and records undeclared emitted kinds as adapter failures", async () => {
  const bad: VerificationEvidenceCollector = {
    id: "bad-declaration",
    kinds: ["file-integrity"],
    supports: () => true,
    collect: () => [{
      type: "runtime-check",
      kind: "browser-runtime",
      claim: "undeclared kind",
      result: "supports"
    }]
  };
  const result = await new VerificationEvidenceCollectorRegistry([bad]).collect({ artifact, profile, maxInspectionBytes: 4096 });
  assert.deepEqual(result.collected, []);
  assert.match(result.failures[0]?.reason ?? "", /undeclared evidence kind browser-runtime/);

  assert.throws(
    () => new VerificationEvidenceCollectorRegistry([bad, bad]),
    /Duplicate verification evidence collector id/
  );
});

test("collector registry fail-closes oversized durable details and transient inspection payloads", async () => {
  const oversized: VerificationEvidenceCollector = {
    id: "oversized",
    kinds: ["browser-runtime"],
    supports: () => true,
    collect: () => [
      {
        type: "runtime-check",
        kind: "browser-runtime",
        claim: "durable details are too large",
        result: "supports",
        details: { body: "x".repeat(40 * 1024) }
      },
      {
        type: "runtime-check",
        kind: "browser-runtime",
        claim: "inspection payload is too large",
        result: "supports",
        inspectionPayload: { body: "y".repeat(40 * 1024) }
      }
    ]
  };

  const result = await new VerificationEvidenceCollectorRegistry([oversized]).collect({
    artifact,
    profile,
    maxInspectionBytes: 4096
  });
  assert.deepEqual(result.collected, []);
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0]?.reason ?? "", /durable evidence details exceed/);
  assert.match(result.failures[1]?.reason ?? "", /inspection payload exceeds/);
});
