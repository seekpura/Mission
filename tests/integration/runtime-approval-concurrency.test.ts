import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

test("concurrent approval decisions resolve host waiters from the first durable event", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });

  try {
    await controller.createMission("mission-approval-race", "race two approval decisions");
    const waiting = approvals.requestHostApproval({
      missionId: "mission-approval-race",
      title: "Race approval",
      reason: "Prove durable first-writer authority",
      details: {}
    });

    let pending = await approvals.listPending("mission-approval-race");
    for (let attempt = 0; pending.length === 0 && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      pending = await approvals.listPending("mission-approval-race");
    }
    assert.equal(pending.length, 1);
    const id = pending[0]!.id;

    const [left, right] = await Promise.all([
      approvals.decide("mission-approval-race", id, { approved: true, scope: "once", actor: "left" }),
      approvals.decide("mission-approval-race", id, { approved: false, scope: "once", actor: "right" })
    ]);
    assert.equal(left.status, right.status);
    assert.equal(left.actor, right.actor);

    const hostResult = await waiting;
    assert.equal(hostResult.approved, left.status === "approved");
    assert.equal(hostResult.scope, "once");

    const decisionEvents = (await events.list("mission-approval-race"))
      .filter(event => event.type === "approval.decided");
    assert.equal(decisionEvents.length, 1);
    const durable = (await approvals.list("mission-approval-race"))[0]!;
    assert.equal(durable.status, left.status);
    assert.equal(durable.actor, left.actor);
  } finally {
    approvals.dispose();
    database.close();
  }
});
