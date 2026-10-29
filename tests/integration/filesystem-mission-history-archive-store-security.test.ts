import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MissionController } from "../../src/core/mission/controller.ts";
import { FilesystemMissionHistoryArchiveStore } from "../../src/persistence/archive/filesystem-mission-history-archive-store.ts";
import { canonicalJsonV1 } from "../../src/persistence/sqlite/mission-history-archive-receipt.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteHistoryReader } from "../../src/persistence/sqlite/sqlite-history-reader.ts";

function schemaPath(): string {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

test("archive store rejects a symlink root before creating child paths through it", async () => {
  const base = await mkdtemp(join(tmpdir(), "mission-archive-root-symlink-"));
  const target = join(base, "target");
  const root = join(base, "archive-root");
  await mkdir(target);
  await symlink(target, root, "dir");
  const store = new FilesystemMissionHistoryArchiveStore(root);

  try {
    await assert.rejects(
      () => store.verifyObject("a".repeat(64)),
      /not a real directory/
    );
    assert.deepEqual(await readdir(target), []);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("archive store rejects unsupported receipt fields even when the manifest remains canonical JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-archive-receipt-shape-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const history = new SqliteHistoryReader(database);
  const store = new FilesystemMissionHistoryArchiveStore(root);
  const missionId = "mission-archive-strict-receipt";

  try {
    await controller.createMission(missionId, "reject unsupported archive receipt fields");
    const archived = await store.createFromHistory(history, missionId);
    assert.ok(archived);

    const manifestPath = join(root, "objects", archived.objectId, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      format: string;
      objectId: string;
      receipt: Record<string, unknown>;
    };
    manifest.receipt.futureExtension = true;
    await writeFile(manifestPath, `${canonicalJsonV1(manifest)}\n`, "utf8");

    await assert.rejects(
      () => store.verifyObject(archived.objectId),
      /receipt contains unsupported fields/
    );
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
