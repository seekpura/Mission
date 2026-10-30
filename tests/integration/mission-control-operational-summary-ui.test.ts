import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
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

test("Mission Control exposes a focused read-only operational summary surface", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const server = createMissionApi(controller, events);

  try {
    const base = await listen(server);
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html/);
    const html = await response.text();

    assert.match(html, /data-surface="operational-summary"/);
    assert.match(html, /id="summary-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="summary-throughput-5"/);
    assert.match(html, /id="summary-throughput-60"/);
    assert.match(html, /id="summary-idle"/);
    assert.match(html, /id="summary-replay-blocks"/);
    assert.match(html, /id="summary-active-capabilities"/);
    assert.match(html, /id="summary-latency"/);
    assert.match(html, /\/summary'/);
    assert.match(html, /function loadOperationalSummary\(/);
    assert.match(html, /function renderOperationalSummary\(/);
    assert.match(html, /summaryLoadGeneration/);
    assert.match(html, /mission\.updated[\s\S]*loadOperationalSummary/);
    assert.match(html, /summaryThroughput5El\.textContent/);
    assert.match(html, /summaryIdleEl\.textContent/);
    assert.match(html, /summaryReplayBlocksEl\.textContent/);
    assert.match(html, /summaryActiveCapabilitiesEl\.textContent/);
    assert.match(html, /summaryLatencyEl\.textContent/);
    assert.doesNotMatch(html, /innerHTML\s*=\s*.*summary/i);
  } finally {
    await closeServer(server);
    database.close();
  }
});
