import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { InvocationReceipt } from "../../src/core/domain/invocation.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections });
  return { db, projections, events, controller };
}

test("governance ledger derives durable cost audit trust and completion records from mission facts", async () => {
  const { db, projections, events, controller } = setup();
  const missionId = "m-governance";
  const now = new Date().toISOString();
  await controller.createMission(missionId, "deliver governed artifact");
  await controller.emit(missionId, "acceptance.revised", { revision: 2, contract: {
    missionId, revision: 2, createdAt: now,
    requirements: [{ id: "R1", description: "deliver artifact", type: "functional", priority: "critical", verification: "artifact", status: "unverified", evidenceRefs: [] }],
    requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }], requiredValidations: [], criticalFailureConditions: []
  } }, { type: "controller" });
  const work: WorkItem = {
    id: "w1", missionId, purpose: "production", objective: "produce deliverable", status: "running",
    requirementRefs: ["R1"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }],
    localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 90, graphRevision: 1,
    createdBy: "planner", createdAt: now, updatedAt: now
  };
  await controller.proposeWork(work);
  await controller.emit(missionId, "approval.requested", { id: "approval-1", requestedAction: "publish external record", target: "external:test" }, { type: "controller" });
  await controller.emit(missionId, "approval.decided", { id: "approval-1", approved: true, scope: "once", target: "external:test" }, { type: "user" });
  await controller.emit(missionId, "capability.activated", { capability: { id: "cap-report", scope: "mission" } }, { type: "controller" });

  const receipt: InvocationReceipt = {
    id: "inv-1", missionId, workItemId: "w1", attemptId: "a1", executionId: "e1",
    route: "host_capability", routeReason: "direct structured capability", capabilityRefs: ["cap-report"], targetRef: "cap-report",
    idempotencyKey: "m-governance:w1:a1", approvalRef: "approval-1",
    sideEffects: [{ type: "external-write", target: "external:test", reversible: true, result: "created" }],
    result: "succeeded", startedAt: "2026-10-28T09:00:00.000Z", endedAt: "2026-10-28T09:00:02.500Z", createdAt: now
  };
  await controller.emit(missionId, "execution.invocation.recorded", { receipt }, { type: "system" });
  await controller.recordArtifact(missionId, {
    id: "deliverable", missionId, logicalName: "deliverable", type: "document", version: 1, status: "verified",
    uri: "/tmp/deliverable.txt", contentHash: "h", producedByAttemptId: "a1", sourceArtifactRefs: [], createdAt: now
  });
  await controller.validateArtifact(missionId, "deliverable@1", true);
  await controller.recordEvidence(missionId, { id: "ev1", missionId, subjectRef: "R1", type: "file-validation", claim: "deliverable exists", result: "supports", validity: "active", createdAt: now });
  await controller.setRequirementStatus(missionId, "R1", "satisfied", ["ev1"]);
  await controller.emit(missionId, "mission.completed", { reason: "fixture complete" }, { type: "controller" });

  const costs = await projections.listCostEvents(missionId);
  assert.equal(costs.find(cost => cost.category === "wall_time")?.quantity, 2500);
  assert.equal(costs.find(cost => cost.category === "external_side_effect")?.quantity, 1);

  const audit = await projections.listAuditRecords(missionId);
  assert.ok(audit.some(record => record.action === "approval.requested"));
  assert.ok(audit.some(record => record.action === "approval.decided"));
  assert.ok(audit.some(record => record.action === "capability.activated"));
  assert.ok(audit.some(record => record.action === "external.side_effect.executed"));
  assert.ok(audit.some(record => record.action === "mission.completed"));

  const trust = await projections.listCapabilityTrustProfiles(missionId);
  assert.deepEqual(trust.map(profile => ({ id: profile.capabilityId, purpose: profile.purpose, attempts: profile.attempts, successRate: profile.successRate })), [
    { id: "cap-report", purpose: "production", attempts: 1, successRate: 1 }
  ]);
  assert.equal(trust[0]?.averageWallTimeMs, 2500);

  const completion = await projections.listCompletionRecords(missionId);
  assert.equal(completion.length, 1);
  assert.equal(completion[0]?.criticalRequirementsSatisfied, 1);
  assert.equal(completion[0]?.criticalRequirementsTotal, 1);
  assert.deepEqual(completion[0]?.finalArtifactRefs, ["deliverable@1"]);
  assert.deepEqual(completion[0]?.blockingGapRefs, []);
  assert.equal(completion[0]?.totalObservedWallTimeMs, 2500);

  projections.rebuild(missionId, await events.list(missionId));
  assert.equal((await projections.listCostEvents(missionId)).find(cost => cost.category === "wall_time")?.quantity, 2500);
  assert.equal((await projections.listAuditRecords(missionId)).some(record => record.action === "mission.completed"), true);
  assert.equal((await projections.listCapabilityTrustProfiles(missionId))[0]?.attempts, 1);
  assert.equal((await projections.listCompletionRecords(missionId)).length, 1);
  db.close();
});
