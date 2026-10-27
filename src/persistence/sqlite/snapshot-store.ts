import { randomUUID } from "node:crypto";
import type { MissionState } from "../../core/domain/mission.ts";
import type { MissionDatabase } from "./database.ts";

export class SnapshotStore {
  private readonly database: MissionDatabase;
  constructor(database: MissionDatabase) { this.database = database; }

  save(state: MissionState) {
    this.database.db.prepare(
      "INSERT INTO snapshots (id, mission_id, event_sequence, state_json, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(randomUUID(), state.missionId, state.lastEventSequence, JSON.stringify(state), new Date().toISOString());
  }

  latest(missionId: string): { sequence: number; state: MissionState } | null {
    const row = this.database.db.prepare(
      "SELECT event_sequence, state_json FROM snapshots WHERE mission_id = ? ORDER BY event_sequence DESC LIMIT 1"
    ).get(missionId) as any;
    if (!row) return null;
    return { sequence: row.event_sequence, state: JSON.parse(row.state_json) };
  }
}
