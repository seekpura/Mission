import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeliberationProvider } from "../core/planning/deliberation-provider.ts";
import { MissionController } from "../core/mission/controller.ts";
import { MissionDatabase } from "../persistence/sqlite/database.ts";
import { SqliteEventStore } from "../persistence/sqlite/sqlite-event-store.ts";
import { SqliteProjectionStore } from "../persistence/sqlite/sqlite-projection-store.ts";
import { SnapshotStore } from "../persistence/sqlite/snapshot-store.ts";

export interface MissionRuntimeOptions {
  dbPath?: string;
  schemaPath?: string;
  deliberation?: DeliberationProvider;
}

export class MissionRuntime {
  readonly database: MissionDatabase;
  readonly projections: SqliteProjectionStore;
  readonly events: SqliteEventStore;
  readonly snapshots: SnapshotStore;
  readonly controller: MissionController;

  constructor(options: MissionRuntimeOptions = {}) {
    const dbPath = options.dbPath ?? join(process.cwd(), ".mission", "mission.db");
    const schemaPath = options.schemaPath ?? fileURLToPath(new URL("../persistence/sqlite/schema.sql", import.meta.url));
    this.database = new MissionDatabase(dbPath);
    this.database.migrate(schemaPath);
    this.projections = new SqliteProjectionStore(this.database);
    this.events = new SqliteEventStore(this.database, this.projections);
    this.snapshots = new SnapshotStore(this.database);
    this.controller = new MissionController(this.events, {
      projections: this.projections,
      deliberation: options.deliberation
    });
  }

  async checkpoint(missionId: string): Promise<void> {
    this.snapshots.save(await this.controller.state(missionId));
  }

  async rebuildProjection(missionId: string): Promise<void> {
    this.database.db.exec("BEGIN IMMEDIATE");
    try {
      this.projections.rebuild(missionId, await this.events.list(missionId));
      this.database.db.exec("COMMIT");
    } catch (error) {
      this.database.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.database.close(); }
}
