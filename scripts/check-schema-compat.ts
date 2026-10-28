import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_PATH = "src/persistence/sqlite/schema.sql";

type SqliteColumn = {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

type SqliteIndex = {
  name: string;
  table: string;
  unique: boolean;
  columns: string[];
};

type SchemaSnapshot = {
  tables: Map<string, SqliteColumn[]>;
  indexes: Map<string, SqliteIndex>;
};

function sqlRows(db: DatabaseSync, sql: string): Record<string, unknown>[] {
  return db.prepare(sql).all() as Record<string, unknown>[];
}

function sqlIdentifierLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function snapshotSchema(db: DatabaseSync): SchemaSnapshot {
  const tables = new Map<string, SqliteColumn[]>();
  const tableRows = sqlRows(
    db,
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  );
  for (const row of tableRows) {
    const name = String(row.name);
    const columns = sqlRows(db, `PRAGMA table_info(${sqlIdentifierLiteral(name)})`).map(row => ({
      cid: Number(row.cid),
      name: String(row.name),
      type: String(row.type ?? "").toUpperCase(),
      notnull: Number(row.notnull),
      dflt_value: row.dflt_value === null || row.dflt_value === undefined ? null : String(row.dflt_value),
      pk: Number(row.pk)
    }));
    tables.set(name, columns);
  }

  const indexes = new Map<string, SqliteIndex>();
  const indexRows = sqlRows(
    db,
    "SELECT name, tbl_name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name"
  );
  for (const row of indexRows) {
    const name = String(row.name);
    const table = String(row.tbl_name);
    const metadata = sqlRows(db, `PRAGMA index_list(${sqlIdentifierLiteral(table)})`)
      .find(item => String(item.name) === name);
    assert(metadata, `SQLite index metadata missing for ${name}`);
    const columns = sqlRows(db, `PRAGMA index_info(${sqlIdentifierLiteral(name)})`)
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map(item => String(item.name));
    indexes.set(name, {
      name,
      table,
      unique: Number(metadata.unique) === 1,
      columns
    });
  }

  return { tables, indexes };
}

function createDatabase(schemaSql: string): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
  db.exec(schemaSql);
  return db;
}

function normalizeColumn(column: SqliteColumn): Omit<SqliteColumn, "cid"> {
  return {
    name: column.name,
    type: column.type,
    notnull: column.notnull,
    dflt_value: column.dflt_value,
    pk: column.pk
  };
}

function assertNoBreakingBaselineChanges(baseline: SchemaSnapshot, current: SchemaSnapshot): void {
  for (const [tableName, baselineColumns] of baseline.tables) {
    const currentColumns = current.tables.get(tableName);
    assert(currentColumns, `Breaking schema change: baseline table ${tableName} is missing from the current fresh schema`);
    const currentByName = new Map(currentColumns.map(column => [column.name, column]));
    for (const baselineColumn of baselineColumns) {
      const currentColumn = currentByName.get(baselineColumn.name);
      assert(
        currentColumn,
        `Breaking schema change: baseline column ${tableName}.${baselineColumn.name} is missing from the current fresh schema`
      );
      assert.deepEqual(
        normalizeColumn(currentColumn),
        normalizeColumn(baselineColumn),
        `Breaking schema change: baseline column contract changed for ${tableName}.${baselineColumn.name}`
      );
    }
  }

  for (const [indexName, baselineIndex] of baseline.indexes) {
    const currentIndex = current.indexes.get(indexName);
    assert(currentIndex, `Breaking schema change: baseline explicit index ${indexName} is missing`);
    assert.deepEqual(currentIndex, baselineIndex, `Breaking schema change: explicit index contract changed for ${indexName}`);
  }
}

function comparableSnapshot(snapshot: SchemaSnapshot): object {
  return {
    tables: [...snapshot.tables.entries()].map(([name, columns]) => ({
      name,
      columns: columns.map(normalizeColumn)
    })),
    indexes: [...snapshot.indexes.values()]
  };
}

function seedCompatibilitySentinels(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO missions(id, status, revision, created_at, updated_at)
    VALUES ('schema-compat-mission', 'active', 7, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

    INSERT INTO mission_events(
      id, mission_id, sequence, type, actor_type, payload_json, schema_version, created_at
    ) VALUES (
      'schema-compat-event', 'schema-compat-mission', 1, 'mission.created', 'runtime', '{}', 1,
      '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO rm_missions(
      mission_id, user_goal, event_sequence, state_json, created_at, updated_at
    ) VALUES (
      'schema-compat-mission', 'preserve me', 1, '{}', '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z'
    );
  `);
}

function assertSentinelsPreserved(db: DatabaseSync): void {
  const mission = db.prepare("SELECT status, revision FROM missions WHERE id = ?").get("schema-compat-mission") as
    | { status: string; revision: number }
    | undefined;
  assert.deepEqual(mission, { status: "active", revision: 7 }, "Migration changed persisted mission sentinel data");

  const event = db.prepare("SELECT type, payload_json FROM mission_events WHERE id = ?").get("schema-compat-event") as
    | { type: string; payload_json: string }
    | undefined;
  assert.deepEqual(
    event,
    { type: "mission.created", payload_json: "{}" },
    "Migration changed persisted event sentinel data"
  );

  const readModel = db.prepare("SELECT user_goal, event_sequence FROM rm_missions WHERE mission_id = ?")
    .get("schema-compat-mission") as { user_goal: string; event_sequence: number } | undefined;
  assert.deepEqual(
    readModel,
    { user_goal: "preserve me", event_sequence: 1 },
    "Migration changed persisted read-model sentinel data"
  );
}

function assertDatabaseHealthy(db: DatabaseSync): void {
  const integrity = db.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
  assert(integrity, "SQLite integrity_check returned no result");
  assert.equal(Object.values(integrity)[0], "ok", `SQLite integrity_check failed: ${JSON.stringify(integrity)}`);
  const foreignKeyViolations = sqlRows(db, "PRAGMA foreign_key_check");
  assert.deepEqual(foreignKeyViolations, [], "SQLite foreign_key_check found violations after migration");
}

function baselineRef(): string {
  const flagIndex = process.argv.indexOf("--baseline-ref");
  if (flagIndex >= 0) {
    const value = process.argv[flagIndex + 1]?.trim();
    if (!value) throw new Error("--baseline-ref requires a git revision");
    return value;
  }
  const configured = process.env.SCHEMA_BASE_REF?.trim();
  if (configured) return configured;
  return process.env.GITHUB_EVENT_NAME === "pull_request" ? "HEAD^1" : "HEAD^";
}

function readBaselineSchema(ref: string): string {
  try {
    return execFileSync("git", ["show", `${ref}:${SCHEMA_PATH}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Unable to read schema compatibility baseline ${ref}:${SCHEMA_PATH}. ` +
      `Set SCHEMA_BASE_REF or pass --baseline-ref explicitly. ${detail}`
    );
  }
}

function main(): void {
  const currentSql = readFileSync(resolve(process.cwd(), SCHEMA_PATH), "utf8");
  const ref = baselineRef();
  const baselineSql = readBaselineSchema(ref);

  const baselineDb = createDatabase(baselineSql);
  const currentDb = createDatabase(currentSql);
  const upgradeDb = createDatabase(baselineSql);
  try {
    const baselineSnapshot = snapshotSchema(baselineDb);
    const currentSnapshot = snapshotSchema(currentDb);
    assertNoBreakingBaselineChanges(baselineSnapshot, currentSnapshot);

    seedCompatibilitySentinels(upgradeDb);
    upgradeDb.exec(currentSql);
    assertSentinelsPreserved(upgradeDb);
    assertDatabaseHealthy(upgradeDb);

    const upgradedSnapshot = snapshotSchema(upgradeDb);
    assert.deepEqual(
      comparableSnapshot(upgradedSnapshot),
      comparableSnapshot(currentSnapshot),
      "Applying the current schema to a baseline database does not produce the same structure as a fresh current database"
    );

    // The production migration entry point can be called on every startup, so the
    // schema program itself must remain safe to execute more than once.
    upgradeDb.exec(currentSql);
    assertSentinelsPreserved(upgradeDb);
    assertDatabaseHealthy(upgradeDb);
    assert.deepEqual(
      comparableSnapshot(snapshotSchema(upgradeDb)),
      comparableSnapshot(currentSnapshot),
      "Current schema is not structurally idempotent across repeated startup migration"
    );

    console.log(
      `schema compatibility gate passed: baseline=${ref} tables=${currentSnapshot.tables.size} indexes=${currentSnapshot.indexes.size}`
    );
  } finally {
    baselineDb.close();
    currentDb.close();
    upgradeDb.close();
  }
}

main();
