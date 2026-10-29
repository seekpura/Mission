import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteOperationalSummaryReader } from "../../src/persistence/sqlite/sqlite-operational-summary-reader.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";

function schemaPath(): string {
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

test("Mission API exposes aggregate operational summary and fails closed without its reader", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const summaryReader = new SqliteOperationalSummaryReader(database);
  const missionId = "mission-summary-api";
  const server = createMissionApi(controller, events, { summaryReader });

  try {
    await controller.createMission(missionId, "observe aggregate health");
    const base = await listen(server);

    const response = await fetch(`${base}/missions/${missionId}/summary`);
    assert.equal(response.status, 200);
    const summary = await response.json() as {
      missionId: string;
      status: string;
      eventSequence: number;
      workItems: Record<string, number>;
      completedExecutionLatencyMs: { sampleCount: number };
    };
    assert.equal(summary.missionId, missionId);
    assert.equal(summary.status, "active");
    assert.equal(summary.eventSequence, 3);
    assert.deepEqual(summary.workItems, {});
    assert.deepEqual(summary.completedExecutionLatencyMs, { sampleCount: 0 });

    const missing = await fetch(`${base}/missions/missing-mission/summary`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "mission_not_found" });
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const base = await listen(noReaderServer);
    const response = await fetch(`${base}/missions/${missionId}/summary`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "operational_summary_reader_unavailable" });
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
