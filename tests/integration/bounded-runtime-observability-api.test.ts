import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MissionEventType } from "../../src/core/domain/event.ts";
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

async function append(
  events: SqliteEventStore,
  missionId: string,
  type: MissionEventType,
  payload: unknown
): Promise<number> {
  const expected = await events.lastSequence(missionId);
  const committed = await events.append({
    id: `fixture-event-${expected + 1}`,
    missionId,
    type,
    actor: { type: "system", id: "bounded-observability-fixture" },
    payload,
    schemaVersion: 1,
    createdAt: new Date(1_800_000_000_000 + expected * 1_000).toISOString()
  }, expected);
  return committed.sequence;
}

test("operational reader bounds and filters activity, attempts and executions", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const missionId = "mission-bounded-observability";

  try {
    await controller.createMission(missionId, "observe a long-running Mission without unbounded reads");

    await append(events, missionId, "attempt.created", {
      id: "attempt-a",
      workItemId: "work-1",
      status: "created"
    });
    await append(events, missionId, "attempt.completed", {
      id: "attempt-a",
      status: "succeeded"
    });
    await append(events, missionId, "attempt.created", {
      id: "attempt-b",
      workItemId: "work-2",
      status: "created"
    });

    await append(events, missionId, "execution.created", {
      id: "execution-a",
      workItemId: "work-1",
      attemptId: "attempt-a"
    });
    await append(events, missionId, "execution.started", { id: "execution-a" });
    await append(events, missionId, "execution.completed", { id: "execution-a" });
    await append(events, missionId, "execution.created", {
      id: "execution-b",
      workItemId: "work-2",
      attemptId: "attempt-b"
    });

    for (let index = 0; index < 105; index += 1) {
      await append(events, missionId, "user.steering.received", { message: `operator note ${index}` });
    }

    const attempts = reader.readAttempts(missionId, { limit: 1 });
    assert.deepEqual(attempts.map(value => value.id), ["attempt-a"]);
    assert.deepEqual(
      reader.readAttempts(missionId, { afterId: "attempt-a" }).map(value => value.id),
      ["attempt-b"]
    );
    assert.deepEqual(
      reader.readAttempts(missionId, { workItemId: "work-1", status: "succeeded" }).map(value => value.id),
      ["attempt-a"]
    );

    assert.deepEqual(
      reader.readExecutions(missionId, { attemptId: "attempt-a", status: "completed" }).map(value => value.id),
      ["execution-a"]
    );
    assert.deepEqual(
      reader.readExecutions(missionId, { afterId: "execution-a" }).map(value => value.id),
      ["execution-b"]
    );

    const firstActivityPage = reader.readActivity(missionId);
    assert.equal(firstActivityPage.length, 100);
    const lastFirstPageSequence = firstActivityPage.at(-1)?.sequence;
    assert.equal(typeof lastFirstPageSequence, "number");
    const secondActivityPage = reader.readActivity(missionId, { afterSequence: lastFirstPageSequence as number });
    assert.ok(secondActivityPage.length > 0);
    assert.ok(secondActivityPage.length < 100);
    assert.ok(secondActivityPage.every(event => event.sequence > (lastFirstPageSequence as number)));
    assert.deepEqual(
      reader.readActivity(missionId, { type: "execution.created" }).map(event => event.payload),
      [
        { id: "execution-a", workItemId: "work-1", attemptId: "attempt-a" },
        { id: "execution-b", workItemId: "work-2", attemptId: "attempt-b" }
      ]
    );
  } finally {
    database.close();
  }
});

test("operational API exposes bounded filters and refuses unsafe no-reader fallback", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const reader = new SqliteMissionReader(database);
  const controller = new MissionController(events);
  const missionId = "mission-bounded-observability-api";
  const server = createMissionApi(controller, events, { operationalReader: reader });

  try {
    await controller.createMission(missionId, "query bounded operational state");
    await append(events, missionId, "attempt.created", {
      id: "attempt-api",
      workItemId: "work-api",
      status: "created"
    });
    await append(events, missionId, "attempt.completed", {
      id: "attempt-api",
      status: "succeeded"
    });
    await append(events, missionId, "execution.created", {
      id: "execution-api",
      workItemId: "work-api",
      attemptId: "attempt-api"
    });
    await append(events, missionId, "execution.completed", { id: "execution-api" });

    const base = await listen(server);

    const activityResponse = await fetch(`${base}/missions/${missionId}/activity?type=execution.created&limit=1`);
    assert.equal(activityResponse.status, 200);
    const activity = await activityResponse.json() as Array<{ sequence: number; type: string }>;
    assert.equal(activity.length, 1);
    assert.equal(activity[0]?.type, "execution.created");

    const attemptResponse = await fetch(
      `${base}/missions/${missionId}/attempts?workItemId=work-api&status=succeeded&limit=1`
    );
    assert.equal(attemptResponse.status, 200);
    const attempts = await attemptResponse.json() as Array<{ id: string }>;
    assert.deepEqual(attempts.map(value => value.id), ["attempt-api"]);

    const executionResponse = await fetch(
      `${base}/missions/${missionId}/executions?attemptId=attempt-api&status=completed&limit=1`
    );
    assert.equal(executionResponse.status, 200);
    const executions = await executionResponse.json() as Array<{ id: string }>;
    assert.deepEqual(executions.map(value => value.id), ["execution-api"]);

    assert.equal((await fetch(`${base}/missions/${missionId}/activity?limit=501`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/attempts?status=bad%20status`)).status, 400);
    assert.equal((await fetch(`${base}/missions/${missionId}/executions?limit=0`)).status, 400);
  } finally {
    await closeServer(server);
  }

  const noReaderServer = createMissionApi(controller, events);
  try {
    const noReaderBase = await listen(noReaderServer);
    const response = await fetch(`${noReaderBase}/missions/${missionId}/activity`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "operational_reader_unavailable" });
  } finally {
    await closeServer(noReaderServer);
    database.close();
  }
});
