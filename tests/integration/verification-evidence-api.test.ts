import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Evidence } from "../../src/core/domain/verification.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
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

async function appendEvidence(events: SqliteEventStore, value: Evidence): Promise<void> {
  const expected = await events.lastSequence(value.missionId);
  await events.append({
    id: `evidence-event-${expected + 1}`,
    missionId: value.missionId,
    type: "evidence.collected",
    actor: { type: "verifier", id: "fixture" },
    payload: value,
    schemaVersion: 1,
    createdAt: value.createdAt
  }, expected);
}

test("Mission API lists durable verification Evidence and filters by subjectRef", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const server = createMissionApi(controller, events, { evidenceReader: reader });
  const missionId = "mission-evidence-api";
  const first: Evidence = {
    id: "evidence-api-1",
    missionId,
    subjectRef: "deck@1",
    type: "render-inspection",
    kind: "presentation-render",
    claim: "Rendered slide evidence exists.",
    result: "supports",
    collectorId: "render-fixture",
    createdAt: "2026-10-29T01:00:00.000Z"
  };
  const second: Evidence = {
    id: "evidence-api-2",
    missionId,
    subjectRef: "site@1",
    type: "runtime-check",
    kind: "browser-runtime",
    claim: "Browser runtime evidence exists.",
    result: "supports",
    collectorId: "browser-fixture",
    createdAt: "2026-10-29T01:01:00.000Z"
  };

  try {
    await controller.createMission(missionId, "query verification evidence");
    await appendEvidence(events, first);
    await appendEvidence(events, second);
    const base = await listen(server);

    const all = await fetch(`${base}/missions/${missionId}/evidence`);
    assert.equal(all.status, 200);
    assert.deepEqual(await all.json(), [first, second]);

    const filtered = await fetch(`${base}/missions/${missionId}/evidence?subjectRef=${encodeURIComponent("deck@1")}`);
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), [first]);
  } finally {
    await closeServer(server);
    database.close();
  }
});
