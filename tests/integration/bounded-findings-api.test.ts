import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Finding } from "../../src/core/domain/verification.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
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

async function appendFinding(events: SqliteEventStore, value: Finding): Promise<void> {
  const expected = await events.lastSequence(value.missionId);
  await events.append({
    id: `finding-event-${expected + 1}`,
    missionId: value.missionId,
    type: "finding.created",
    actor: { type: "verifier", id: "finding-api-fixture" },
    payload: value,
    schemaVersion: 1,
    createdAt: value.createdAt
  }, expected);
}

function finding(missionId: string, id: string, createdAt: string): Finding {
  return {
    id,
    missionId,
    artifactRef: "artifact@1",
    category: "content",
    severity: "major",
    observation: `observation ${id}`,
    expected: "expected content",
    requirementRefs: ["req-1"],
    evidenceRefs: ["evidence-1"],
    confidence: 0.9,
    createdAt
  };
}

test("Mission API exposes bounded Finding history with a stable lexical id cursor", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const missionId = "mission-findings-api";
  const first = finding(missionId, "finding-a", "2026-10-29T06:10:00.000Z");
  const second = finding(missionId, "finding-b", "2026-10-29T06:11:00.000Z");
  const server = createMissionApi(controller, events, { findingReader: reader });

  try {
    await controller.createMission(missionId, "query bounded findings");
    await appendFinding(events, first);
    await appendFinding(events, second);
    const base = await listen(server);

    const firstPage = await fetch(`${base}/missions/${missionId}/findings?limit=1`);
    assert.equal(firstPage.status, 200);
    assert.deepEqual(await firstPage.json(), [first]);

    const secondPage = await fetch(`${base}/missions/${missionId}/findings?afterId=finding-a&limit=1`);
    assert.equal(secondPage.status, 200);
    assert.deepEqual(await secondPage.json(), [second]);

    assert.equal((await fetch(`${base}/missions/${missionId}/findings?limit=501`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/findings?afterId=${"x".repeat(257)}`)).status, 400);
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const base = await listen(noReaderServer);
    const response = await fetch(`${base}/missions/${missionId}/findings`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "finding_reader_unavailable" });
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
