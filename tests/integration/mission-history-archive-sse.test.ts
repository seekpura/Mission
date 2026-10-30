import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";
import { RuntimeMissionHistoryArchiveOperator } from "../../src/runtime/mission-history-archive-operator.ts";
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

type ByteReader = {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(): Promise<void>;
};

async function readSseEvent(
  reader: ByteReader,
  state: { buffer: string },
  timeoutMs = 1_000
): Promise<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const boundary = state.buffer.indexOf("\n\n");
    if (boundary >= 0) {
      const block = state.buffer.slice(0, boundary);
      state.buffer = state.buffer.slice(boundary + 2);
      const event = block.split("\n").find(line => line.startsWith("event: "))?.slice(7);
      const data = block.split("\n").find(line => line.startsWith("data: "))?.slice(6);
      if (!event || data === undefined) throw new Error(`Malformed SSE block: ${block}`);
      return { event, data };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Timed out waiting for SSE event");
    const chunk = await readWithTimeout(reader, remaining);
    if (chunk.done) throw new Error("SSE stream ended before the expected event");
    state.buffer += decoder.decode(chunk.value, { stream: true });
  }
}

async function readWithTimeout(
  reader: ByteReader,
  timeoutMs: number
): Promise<{ done: boolean; value?: Uint8Array }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Timed out waiting for SSE event")), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("successful archive creation publishes the durable Mission revision to existing SSE subscribers", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-sse-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const historyReader = new SqliteHistoryReader(database);
  const historyArchive = new RuntimeMissionHistoryArchiveOperator(
    historyReader,
    new FileMissionHistoryArchiveStore(root),
    events
  );
  const missionId = "mission-archive-sse";
  const server = createMissionApi(controller, events, { historyReader, historyArchive });
  const abort = new AbortController();
  let reader: ByteReader | undefined;

  try {
    await controller.createMission(missionId, "publish archive registration to Mission Control");
    const throughSequence = await events.lastSequence(missionId);
    const base = await listen(server);

    const streamResponse = await fetch(`${base}/missions/${missionId}/events`, { signal: abort.signal });
    assert.equal(streamResponse.status, 200);
    assert.ok(streamResponse.body);
    reader = streamResponse.body.getReader();
    const streamState = { buffer: "" };

    const initialEvent = await readSseEvent(reader, streamState);
    assert.equal(initialEvent.event, "mission.updated");
    const initialState = JSON.parse(initialEvent.data) as { revision: number; lastEventSequence: number };
    assert.equal(initialState.lastEventSequence, throughSequence);

    const createResponse = await fetch(`${base}/missions/${missionId}/history/archive`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ throughSequence })
    });
    assert.equal(createResponse.status, 200);

    const updatedEvent = await readSseEvent(reader, streamState);
    assert.equal(updatedEvent.event, "mission.updated");
    const updatedState = JSON.parse(updatedEvent.data) as { revision: number; lastEventSequence: number };
    assert.equal(updatedState.revision, initialState.revision + 1);
    assert.equal(updatedState.lastEventSequence, throughSequence + 1);
  } finally {
    abort.abort();
    await reader?.cancel().catch(() => undefined);
    await closeServer(server);
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
