import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityCandidate, CapabilityDescriptor, SecurityAssessment } from "../../src/core/domain/capability.ts";
import type { CapabilitySourceIdentity } from "../../src/core/domain/capability-ledger.ts";
import {
  FileTrustedCapabilityCache,
  capabilityCacheKey
} from "../../src/core/capabilities/trusted-capability-cache.ts";

const IDENTITY: CapabilitySourceIdentity = {
  sourceType: "github",
  sourceUri: "https://github.com/example/example-skill",
  resolvedRevision: "0123456789abcdef0123456789abcdef01234567",
  contentHash: `sha256:${"1".repeat(64)}`
};

function candidate(): CapabilityCandidate {
  return {
    id: "candidate-1",
    sourceType: "github",
    sourceUri: IDENTITY.sourceUri,
    name: "example/example-skill",
    candidateKind: "skill",
    status: "verified",
    resolvedRevision: IDENTITY.resolvedRevision,
    contentHash: IDENTITY.contentHash
  };
}

function security(): SecurityAssessment {
  return {
    candidateId: "candidate-1",
    overall: "low",
    findings: [],
    requestedPermissions: [],
    requiredSecrets: []
  };
}

test("trusted capability cache reuses only exact immutable identity and detects bundle mutation", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-trusted-cache-"));
  try {
    const source = join(root, "activated-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: test\n---\n# Example\n", "utf8");

    const capability: CapabilityDescriptor = {
      id: "acquired:example-skill",
      kind: "skill",
      name: "example-skill",
      description: "Example skill",
      hostNative: false,
      available: true,
      invocationRef: source,
      permissions: [],
      revision: IDENTITY.resolvedRevision,
      scope: "mission",
      functions: ["example"],
      provenance: {
        source: "external",
        sourceRef: IDENTITY.sourceUri,
        revision: IDENTITY.resolvedRevision,
        contentHash: IDENTITY.contentHash
      }
    };
    const cache = new FileTrustedCapabilityCache(join(root, "cache"));
    const stored = cache.store({
      identity: IDENTITY,
      candidate: candidate(),
      capability,
      security: security(),
      policy: { action: "require_approval", reason: "external instructions", constraints: ["mission-local"] },
      smoke: {
        executorId: "isolated-test",
        isolationLevel: "container",
        command: "validate-skill",
        args: [],
        passed: true,
        exitCode: 0,
        timedOut: false,
        stdoutTail: "ok",
        stderrTail: "",
        startedAt: "2026-10-29T00:00:00.000Z",
        endedAt: "2026-10-29T00:00:01.000Z"
      }
    });

    assert.equal(stored.cacheKey, capabilityCacheKey(IDENTITY));
    const hit = cache.find(IDENTITY);
    assert.ok(hit);
    assert.equal(hit.record.identity.contentHash, IDENTITY.contentHash);
    assert.equal(hit.record.smoke.passed, true);

    assert.equal(cache.find({ ...IDENTITY, resolvedRevision: "different-revision" }), undefined);

    writeFileSync(join(hit.bundleRoot, "SKILL.md"), "mutated", "utf8");
    assert.throws(() => cache.find(IDENTITY), /bundle hash mismatch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trusted capability cache revocation makes an exact entry unavailable", () => {
  const root = mkdtempSync(join(tmpdir(), "mission-trusted-cache-revoke-"));
  try {
    const source = join(root, "activated-skill");
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, "SKILL.md"), "---\nname: example-skill\ndescription: test\n---\n", "utf8");
    const cache = new FileTrustedCapabilityCache(join(root, "cache"));
    const capability: CapabilityDescriptor = {
      id: "acquired:example-skill",
      kind: "skill",
      name: "example-skill",
      description: "Example skill",
      hostNative: false,
      available: true,
      invocationRef: source,
      permissions: [],
      revision: IDENTITY.resolvedRevision,
      scope: "mission"
    };
    const stored = cache.store({
      identity: IDENTITY,
      candidate: candidate(),
      capability,
      security: security(),
      policy: { action: "allow", reason: "test", constraints: [] },
      smoke: {
        executorId: "isolated-test",
        isolationLevel: "container",
        command: "validate-skill",
        args: [],
        passed: true,
        exitCode: 0,
        timedOut: false,
        stdoutTail: "",
        stderrTail: "",
        startedAt: "2026-10-29T00:00:00.000Z",
        endedAt: "2026-10-29T00:00:01.000Z"
      }
    });

    cache.revoke(stored.cacheKey, "operator revoked trust");
    assert.equal(cache.find(IDENTITY), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
