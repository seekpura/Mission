import test from "node:test";
import assert from "node:assert/strict";
import { HostSideEffectScopeRegistry } from "../../src/runtime/side-effect-host-scope.ts";

const policy = {
  externalWrites: "approval" as const,
  destructiveWrites: "deny" as const,
  irreversibleActions: "approval" as const,
  idempotencyRequired: true
};

test("host side-effect scope restores runtime metadata and provider details cannot override it", () => {
  const registry = new HostSideEffectScopeRegistry();
  const release = registry.register({
    missionId: "mission-1",
    workItemId: "work-1",
    attemptId: "attempt-runtime",
    executionId: "execution-runtime",
    context: {},
    allowedCapabilityRefs: [],
    workspaceRoot: "/tmp/runtime-workspace",
    sideEffectPolicy: policy
  });

  const enriched = registry.enrich({
    missionId: "mission-1",
    title: "permission",
    reason: "tool",
    details: {
      workItemId: "work-1",
      attemptId: "provider-attempt",
      executionId: "provider-execution",
      workspaceRoot: "/outside",
      sideEffectPolicy: { externalWrites: "allow", destructiveWrites: "approval", irreversibleActions: "approval", idempotencyRequired: false },
      toolCall: { toolCallId: "tool-1" }
    }
  });

  assert.equal(enriched.details?.attemptId, "attempt-runtime");
  assert.equal(enriched.details?.executionId, "execution-runtime");
  assert.equal(enriched.details?.workspaceRoot, "/tmp/runtime-workspace");
  assert.deepEqual(enriched.details?.sideEffectPolicy, policy);
  assert.deepEqual(enriched.details?.toolCall, { toolCallId: "tool-1" });

  release();
  const afterRelease = registry.enrich({
    missionId: "mission-1",
    title: "permission",
    reason: "tool",
    details: { workItemId: "work-1", workspaceRoot: "/provider" }
  });
  assert.equal(afterRelease.details?.workspaceRoot, "/provider");
});

test("conflicting concurrent scopes for one WorkItem fail closed", () => {
  const registry = new HostSideEffectScopeRegistry();
  registry.register({
    missionId: "mission-1",
    workItemId: "work-1",
    executionId: "execution-a",
    context: {},
    allowedCapabilityRefs: []
  });
  assert.throws(() => registry.register({
    missionId: "mission-1",
    workItemId: "work-1",
    executionId: "execution-b",
    context: {},
    allowedCapabilityRefs: []
  }), /Concurrent Host side-effect scopes/);
});
