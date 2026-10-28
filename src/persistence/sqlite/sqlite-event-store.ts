import { randomUUID } from "node:crypto";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { EventStore } from "../../core/events/event-store.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";
import { SqliteEvidenceProjector } from "./sqlite-evidence-projector.ts";
import { SqliteReadModelProjector } from "./sqlite-read-model-projector.ts";
import { SqliteSteeringProjector } from "./sqlite-steering-projector.ts";

export class ConcurrencyConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

export class SqliteEventStore implements EventStore {
  private readonly database: MissionDatabase;
  private readonly projector: SqliteReadModelProjector;
  private readonly evidenceProjector: SqliteEvidenceProjector;
  private readonly steeringProjector: SqliteSteeringProjector;

  constructor(database: MissionDatabase) {
    this.database = database;
    this.projector = new SqliteReadModelProjector(database);
    this.evidenceProjector = new SqliteEvidenceProjector(database);
    this.steeringProjector = new SqliteSteeringProjector(database);
    this.projector.catchUpAll();
    this.evidenceProjector.catchUpAll();
    this.steeringProjector.catchUpAll();
  }

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      this.projector.catchUpMission(event.missionId);
      this.evidenceProjector.catchUpMission(event.missionId);
      this.steeringProjector.catchUpMission(event.missionId);

      if (event.idempotencyKey) {
        const existing = db.prepare(
          "SELECT * FROM mission_events WHERE mission_id = ? AND idempotency_key = ?"
        ).get(event.missionId, event.idempotencyKey) as unknown as SqliteMissionEventRow | undefined;
        if (existing) {
          db.exec("COMMIT");
          return rowToMissionEvent(existing) as MissionEvent<T>;
        }
      }

      const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM mission_events WHERE mission_id = ?")
        .get(event.missionId) as { seq: number };
      if (row.seq !== expectedSequence) {
        throw new ConcurrencyConflictError(`expected sequence ${expectedSequence}, actual ${row.seq}`);
      }
      const sequence = row.seq + 1;
      const committed = { ...event, sequence } as MissionEvent<T>;
      db.prepare(`INSERT INTO mission_events
        (id, mission_id, sequence, type, actor_type, actor_id, payload_json, causation_id, correlation_id, idempotency_key, schema_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id || randomUUID(), event.missionId, sequence, event.type, event.actor.type, event.actor.id ?? null,
          JSON.stringify(event.payload), event.causationId ?? null, event.correlationId ?? null, event.idempotencyKey ?? null,
          event.schemaVersion, event.createdAt
        );
      this.projector.applyEvent(committed);
      this.evidenceProjector.applyEvent(committed);
      this.steeringProjector.applyEvent(committed);
      db.exec("COMMIT");
      return committed;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    const rows = this.database.db.prepare(
      "SELECT * FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence ASC"
    ).all(missionId, afterSequence) as unknown as SqliteMissionEventRow[];
    return rows.map(rowToMissionEvent);
  }

  async lastSequence(missionId: string): Promise<number> {
    const row = this.database.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM mission_events WHERE mission_id = ?")
      .get(missionId) as { seq: number };
    return row.seq;
  }
}
