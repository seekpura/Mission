import type { MissionDatabase } from "./database.ts";

export interface MissionCatalog {
  listMissionIds(): Promise<string[]>;
}

export class SqliteMissionCatalog implements MissionCatalog {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) {
    this.database = database;
  }

  async listMissionIds(): Promise<string[]> {
    const rows = this.database.db.prepare(
      "SELECT DISTINCT mission_id AS id FROM mission_events ORDER BY mission_id ASC"
    ).all() as Array<{ id: string }>;
    return rows.map(row => row.id);
  }
}
