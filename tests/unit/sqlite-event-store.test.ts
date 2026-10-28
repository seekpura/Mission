import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore, ConcurrencyConflictError } from "../../src/persistence/sqlite/sqlite-event-store.ts";

function makeStore() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  return { db, store: new SqliteEventStore(db) };
}

test("SQLite event store appends in order and enforces optimistic concurrency", async () => {
  const { db, store } = makeStore();
  const e1 = await store.append({
    id: "e1", missionId: "m1", type: "mission.created", actor: { type: "user" }, payload: {}, schemaVersion: 1, createdAt: new Date().toISOString()
  }, 0);
  assert.equal(e1.sequence, 1);
  await assert.rejects(() => store.append({
    id: "e2", missionId: "m1", type: "mission.completed", actor: { type: "controller" }, payload: {}, schemaVersion: 1, createdAt: new Date().toISOString()
  }, 0), error => {
    assert.equal(error instanceof ConcurrencyConflictError, true);
    assert.equal((error as Error).name, "ConcurrencyConflictError");
    return true;
  });
  const events = await store.list("m1");
  assert.equal(events.length, 1);
  db.close();
});

test("idempotency key returns the already committed event", async () => {
  const { db, store } = makeStore();
  const base = { id: "e1", missionId: "m2", type: "gap.opened" as const, actor: { type: "verifier" as const }, payload: { id: "g1", severity: "major" }, idempotencyKey: "gap:g1", schemaVersion: 1, createdAt: new Date().toISOString() };
  const a = await store.append(base, 0);
  const b = await store.append({ ...base, id: "e2" }, 1);
  assert.equal(a.sequence, b.sequence);
  assert.equal((await store.list("m2")).length, 1);
  db.close();
});
