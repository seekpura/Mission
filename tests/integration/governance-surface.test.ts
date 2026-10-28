import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { BudgetManager } from "../../src/core/budget/budget-manager.ts";
import { MissionGovernanceViewBuilder } from "../../src/core/governance/mission-governance-view.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections });
  const budget = new BudgetManager({ controller, events, projections });
  const governance = new MissionGovernanceViewBuilder({ projections, budget });
  return { db, projections, events, controller, budget, governance };
}

async function listen(server: ReturnType<typeof createMissionApi>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createMissionApi>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("governance HTTP surface exposes mission-semantic budget cost audit trust and completion views", async () => {
  const { db, projections, events, controller, budget, governance } = setup();
  const missionId = "m-governance-surface";
  await controller.createMission(missionId, "show governance state");

  const server = createMissionApi(controller, events, {
    projections,
    governance,
    configureBudget: configured => budget.configure(configured)
  });
  const base = await listen(server);
  try {
    const initial = await fetch(`${base}/missions/${missionId}/governance`).then(response => response.json());
    assert.equal(initial.missionId, missionId);
    assert.equal(initial.budget.policy, null);
    assert.equal(initial.budget.assessment.configured, false);
    assert.equal(initial.observedCost.executionWallTimeMs, 0);
    assert.deepEqual(initial.trust, []);
    assert.equal(initial.completion, null);

    const configured = await fetch(`${base}/missions/${missionId}/budget`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, limits: [{ metric: "attempts", limit: 3, warningAt: 2, enforcement: "hard" }] })
    });
    assert.equal(configured.status, 200);
    const configuredBody = await configured.json();
    assert.equal(configuredBody.policy.missionId, missionId);
    assert.equal(configuredBody.policy.revision, 1);
    assert.equal(configuredBody.assessment.findings[0].metric, "attempts");
    assert.equal(configuredBody.assessment.findings[0].remaining, 3);

    const budgetView = await fetch(`${base}/missions/${missionId}/budget`).then(response => response.json());
    const costView = await fetch(`${base}/missions/${missionId}/cost`).then(response => response.json());
    const auditView = await fetch(`${base}/missions/${missionId}/audit?auditLimit=5`).then(response => response.json());
    const trustView = await fetch(`${base}/missions/${missionId}/trust`).then(response => response.json());
    const completionView = await fetch(`${base}/missions/${missionId}/completion`).then(response => response.json());

    assert.equal(budgetView.policy.revision, 1);
    assert.equal(costView.executionWallTimeMs, 0);
    assert.ok(Array.isArray(auditView));
    assert.deepEqual(trustView, []);
    assert.equal(completionView, null);
  } finally {
    await close(server);
    db.close();
  }
});

test("Mission Control consumes the governance view instead of relying on raw state only", () => {
  const html = readFileSync(join(process.cwd(), "src", "ui", "mission-control.html"), "utf8");
  assert.match(html, /\/governance\?auditLimit=20/);
  assert.match(html, /Budget \/ 预算/);
  assert.match(html, /Capability trust \/ 能力可靠性/);
  assert.match(html, /Completion basis \/ 完成依据/);
  assert.match(html, /Observed runtime/);
});
