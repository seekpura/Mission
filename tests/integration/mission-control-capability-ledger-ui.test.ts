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

test("Mission Control exposes bounded read-only capability trust and lifecycle history", async () => {
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

    assert.match(html, /data-surface="capability-ledger"/);
    assert.match(html, /id="capability-ledger-status"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /id="capability-ledger-count"/);
    assert.match(html, /id="capability-ledger"/);
    assert.match(html, /\/capabilities\/ledger\?limit=10/);
    assert.match(html, /function loadCapabilityLedger\(/);
    assert.match(html, /function renderCapabilityLedger\(/);
    assert.match(html, /capabilityLedgerLoadGeneration/);
    assert.match(html, /mission\.updated[\s\S]*loadCapabilityLedger/);
    assert.match(html, /capabilityId[^\n]*textContent/);
    assert.match(html, /trustLevel[^\n]*textContent/);
    assert.match(html, /provenanceSource[^\n]*textContent/);
    assert.match(html, /decision[^\n]*textContent/);
    assert.match(html, /reason[^\n]*textContent/);
    assert.doesNotMatch(html, /innerHTML\s*=\s*.*capability.?ledger/i);
    assert.doesNotMatch(html, /\/capabilities\/[^'"`]+\/(?:deactivate|revoke)[\s\S]{0,120}method:\s*['"]POST['"]/i);
    assert.doesNotMatch(html, /\/capabilities\/cache\/[^'"`]+\/revoke[\s\S]{0,120}method:\s*['"]POST['"]/i);
  } finally {
    await closeServer(server);
    database.close();
  }
});
