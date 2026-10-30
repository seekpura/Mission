import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    missionId: "mission-idempotent-acquisition-approval",
    candidateId: "mcp-registry:docs.search",
    capabilityNeedId: "need-docs",
    title: "Approve external MCP: docs_search",
    reason: "Remote MCP tools require explicit approval",
    details: {
      sourceUri: "mcp-registry:docs.search@2026-10-30.r1",
      resolvedRevision: "2026-10-30.r1",
      contentHash: `sha256:${"a".repeat(64)}`
    },
    idempotencyKey: `external-mcp\u0000need-docs\u0000docs.search\u00002026-10-30.r1\u0000${"a".repeat(64)}`,
    ...overrides
  } as any;
}

async function pending(manager: RuntimeApprovalManager) {
  let records = await manager.listPending("mission-idempotent-acquisition-approval");
  for (let attempt = 0; records.length === 0 && attempt < 20; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    records = await manager.listPending("mission-idempotent-acquisition-approval");
  }
  return records;
}

test("acquisition approval idempotency shares one durable request and reuses its decision across restart", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  let approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });

  try {
    await controller.createMission("mission-idempotent-acquisition-approval", "prove stable acquisition approval identity");

    const first = approvals.requestApproval(request());
    const concurrent = approvals.requestApproval(request());
    const records = await pending(approvals);
    assert.equal(records.length, 1);
    assert.match(records[0]!.id, /^approval:acquisition:[a-f0-9]{64}$/);

    await approvals.decide(
      "mission-idempotent-acquisition-approval",
      records[0]!.id,
      { approved: true, scope: "once", actor: "user:test" }
    );
    assert.deepEqual(await Promise.all([first, concurrent]), [
      { approved: true, actor: "user" },
      { approved: true, actor: "user" }
    ]);
    assert.equal(
      (await events.list("mission-idempotent-acquisition-approval")).filter(event => event.type === "approval.requested").length,
      1
    );

    approvals.dispose();
    approvals = new RuntimeApprovalManager(events, { timeoutMs: 10_000 });
    const reused = await Promise.race([
      approvals.requestApproval(request()),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("idempotent approval retry did not reuse durable decision")), 100))
    ]);
    assert.deepEqual(reused, { approved: true, actor: "user" });
    assert.equal(
      (await events.list("mission-idempotent-acquisition-approval")).filter(event => event.type === "approval.requested").length,
      1
    );

    await assert.rejects(
      () => approvals.requestApproval(request({ candidateId: "mcp-registry:other" })),
      /idempotent approval request identity mismatch/i
    );
  } finally {
    approvals.dispose();
    database.close();
  }
});
