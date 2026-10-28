import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function listen(server: ReturnType<typeof createMissionApi>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createMissionApi>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("approval request is durable before HTTP decision releases the waiting host request", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-approval-api-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });
  const server = createMissionApi(controller, events, { approvals });

  try {
    await controller.createMission("mission-approval-api", "exercise durable approval");
    const base = await listen(server);
    const waiting = approvals.requestHostApproval({
      missionId: "mission-approval-api",
      title: "Allow test edit",
      reason: "Host requested permission for a deterministic test action",
      details: { toolCallId: "tool-1" }
    });

    let pending = await approvals.listPending("mission-approval-api");
    for (let attempt = 0; pending.length === 0 && attempt < 20; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5));
      pending = await approvals.listPending("mission-approval-api");
    }
    assert.equal(pending.length, 1);

    const beforeDecision = await events.list("mission-approval-api");
    assert.equal(beforeDecision.at(-1)?.type, "approval.requested");

    const response = await fetch(`${base}/missions/mission-approval-api/approvals/${encodeURIComponent(pending[0]!.id)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approved: true, scope: "once", actor: "test-user" })
    });
    assert.equal(response.status, 200);

    const result = await waiting;
    assert.deepEqual(result, { approved: true, scope: "once" });
    assert.deepEqual(await approvals.listPending("mission-approval-api"), []);

    const afterDecision = await events.list("mission-approval-api");
    assert.equal(afterDecision.at(-1)?.type, "approval.decided");
    const state = await controller.state("mission-approval-api");
    assert.deepEqual(state.pendingApprovalIds, []);
  } finally {
    await closeServer(server);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
