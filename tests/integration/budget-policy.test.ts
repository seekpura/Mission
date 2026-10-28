import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  return { db, events, controller: new MissionController(events, { projections }) };
}

test("measured token cost exhausts budget while unknown usage consumes nothing", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-token-budget", "deliver artifact");
  await controller.configureBudget("m-token-budget", { tokenBudget: 100 });
  let assessment = await controller.budgetAssessment("m-token-budget");
  assert.equal(assessment.usage.totalTokens, 0);
  assert.equal(assessment.exhausted, false);
  await controller.recordCost("m-token-budget", { id: "c1", missionId: "m-token-budget", usage: { source: "host-reported", inputTokens: 60, outputTokens: 40 }, recordedAt: new Date().toISOString() });
  assessment = await controller.budgetAssessment("m-token-budget");
  assert.equal(assessment.usage.totalTokens, 100);
  assert.equal(assessment.exhausted, true);
  const cycle = await controller.runControllerCycle({ missionId: "m-token-budget", trigger: "execution_event" });
  assert.equal(cycle.status, "budget_exhausted");
  assert.notEqual(cycle.status, "plateau");
  db.close();
});

test("attempt budget is a hard admission limit and can be resumed by increasing budget", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-attempt-budget", "deliver artifact");
  await controller.configureBudget("m-attempt-budget", { maxAttempts: 1 });
  await controller.emit("m-attempt-budget", "attempt.created", { attempt: { id: "a1" } }, { type: "controller" });
  const exhausted = await controller.runControllerCycle({ missionId: "m-attempt-budget", trigger: "execution_event" });
  assert.equal(exhausted.status, "budget_exhausted");
  const resumed = await controller.configureBudget("m-attempt-budget", { maxAttempts: 2 });
  assert.equal(resumed.exhausted, false);
  assert.equal((await controller.state("m-attempt-budget")).status, "active");
  db.close();
});

test("concurrency budget limits slots without declaring budget exhausted", async () => {
  const { db, controller } = setup();
  await controller.createMission("m-concurrency", "deliver artifact");
  await controller.configureBudget("m-concurrency", { maxConcurrentExecutions: 1 });
  await controller.emit("m-concurrency", "execution.created", { id: "e1", workItemId: "w1", attemptId: "a1", status: "created" }, { type: "controller" });
  await controller.emit("m-concurrency", "execution.started", { id: "e1", workItemId: "w1", attemptId: "a1" }, { type: "host" });
  const assessment = await controller.budgetAssessment("m-concurrency");
  assert.equal(assessment.availableExecutionSlots, 0);
  assert.equal(assessment.exhausted, false);
  db.close();
});
