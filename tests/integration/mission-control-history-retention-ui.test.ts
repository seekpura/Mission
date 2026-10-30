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

test("Mission Control exposes read-only full-history retention safety state", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const server = createMissionApi(controller, events);

  try {
    const base = await listen(server);
    const response = await fetch(base);
    assert.equal(response.status, 200);
    const html = await response.text();

    assert.match(html, /data-surface="history-retention"/);
    assert.match(html, /id="retention-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="retention-mode"/);
    assert.match(html, /id="retention-latest-sequence"/);
    assert.match(html, /id="retention-snapshot-sequence"/);
    assert.match(html, /id="retention-deletion-eligible"/);
    assert.match(html, /id="retention-reason"/);
    assert.match(html, /\/history\/retention'/);
    assert.match(html, /function loadHistoryRetention\(/);
    assert.match(html, /function renderHistoryRetention\(/);
    assert.match(html, /retentionLoadGeneration/);
    assert.match(html, /mission\.updated[\s\S]*loadHistoryRetention/);
    assert.match(html, /retentionModeEl\.textContent/);
    assert.match(html, /retentionLatestSequenceEl\.textContent/);
    assert.match(html, /retentionSnapshotSequenceEl\.textContent/);
    assert.match(html, /retentionDeletionEligibleEl\.textContent/);
    assert.match(html, /retentionReasonEl\.textContent/);
    assert.doesNotMatch(html, /innerHTML\s*=\s*.*retention/i);
    assert.doesNotMatch(html, /history\/retention['"`][\s\S]{0,120}method:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/i);
  } finally {
    await closeServer(server);
    database.close();
  }
});
