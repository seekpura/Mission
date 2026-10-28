import type { DatabaseSync } from "node:sqlite";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

const PROJECTION_NAME = "mission-steering-read-model-v1";
const MAX_STEERING_CHARS = 64 * 1024;

/**
 * Independent projection for durable user steering. Keeping steering outside the
 * primary rm_missions row avoids schema-alter migrations for existing databases
 * and gives the stream its own rebuildable checkpoint.
 */
export class SqliteSteeringProjector {
  private readonly db: DatabaseSync;

  constructor(database: MissionDatabase) {
    this.db = database.db;
  }

  catchUpAll(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        "SELECT DISTINCT mission_id FROM mission_events ORDER BY mission_id"
      ).all() as Array<{ mission_id: string }>;
      for (const row of rows) this.catchUpMission(row.mission_id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Caller already owns the write transaction when invoked from append. */
  catchUpMission(missionId: string): void {
    const checkpoint = this.checkpoint(missionId);
    const rows = this.db.prepare(
      "SELECT * FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence ASC"
    ).all(missionId, checkpoint) as unknown as SqliteMissionEventRow[];
    for (const row of rows) this.applyEvent(rowToMissionEvent(row));
  }

  /** Caller already owns the SQLite write transaction. */
  applyEvent(event: MissionEvent): void {
    const checkpoint = this.checkpoint(event.missionId);
    if (event.sequence <= checkpoint) return;
    if (event.sequence !== checkpoint + 1) {
      throw new Error(
        `Steering projection sequence gap for ${event.missionId}: checkpoint=${checkpoint}, event=${event.sequence}`
      );
    }

    if (event.type === "user.steering.received") this.insertSteering(event);
    this.db.prepare(`
      INSERT INTO rm_projection_checkpoints (projection_name, mission_id, event_sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(projection_name, mission_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        updated_at = excluded.updated_at
    `).run(PROJECTION_NAME, event.missionId, event.sequence, event.createdAt);
  }

  private checkpoint(missionId: string): number {
    const row = this.db.prepare(
      "SELECT event_sequence FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).get(PROJECTION_NAME, missionId) as { event_sequence?: number } | undefined;
    return row?.event_sequence ?? 0;
  }

  private insertSteering(event: MissionEvent): void {
    if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
      throw new Error("user.steering.received requires an object payload");
    }
    const raw = (event.payload as { message?: unknown }).message;
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("user.steering.received requires a non-empty message");
    }
    const message = raw.trim();
    if (message.length > MAX_STEERING_CHARS) {
      throw new Error(`User steering exceeds ${MAX_STEERING_CHARS} characters`);
    }
    this.db.prepare(`
      INSERT OR REPLACE INTO rm_steering_messages
        (mission_id, event_sequence, message, received_at)
      VALUES (?, ?, ?, ?)
    `).run(event.missionId, event.sequence, message, event.createdAt);
  }
}
