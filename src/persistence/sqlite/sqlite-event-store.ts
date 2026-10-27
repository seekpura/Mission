import { randomUUID } from "node:crypto";
import type { MissionEvent } from "../../core/domain/event.ts";
import { OptimisticConcurrencyError, type EventStore } from "../../core/events/event-store.ts";
import type { MissionProjectionWriter } from "../../core/events/projection-store.ts";
import type { MissionDatabase } from "./database.ts";

export class ConcurrencyConflictError extends OptimisticConcurrencyError {
  constructor(message: string) {
    super(message);
    this.name = "ConcurrencyConflictError";
  }
}

export class SqliteEventStore implements EventStore {
  private readonly database: MissionDatabase;
  private readonly projections?: MissionProjectionWriter;

  constructor(database: MissionDatabase, projections?: MissionProjectionWriter) {
    this.database = database;
    this.projections = projections;
  }

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const db = this.database.db;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (event.idempotencyKey) {
        const existing = db.prepare(
          "SELECT * FROM mission_events WHERE mission_id = ? AND idempotency_key = ?"
        ).get(event.missionId, event.idempotencyKey) as any;
        if (existing) {
          db.exec("COMMIT");
          return rowToEvent(existing) as MissionEvent<T>;
        }
      }

      const row = db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM mission_events WHERE mission_id = ?")
        .get(event.missionId) as { seq: number };
      if (row.seq !== expectedSequence) {
        throw new ConcurrencyConflictError(`expected sequence ${expectedSequence}, actual ${row.seq}`);
      }
      const sequence = row.seq + 1;
      db.prepare(`INSERT INTO mission_events
        (id, mission_id, sequence, type, actor_type, actor_id, payload_json, causation_id, correlation_id, idempotency_key, schema_version, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          event.id || randomUUID(), event.missionId, sequence, event.type, event.actor.type, event.actor.id ?? null,
          JSON.stringify(event.payload), event.causationId ?? null, event.correlationId ?? null, event.idempotencyKey ?? null,
          event.schemaVersion, event.createdAt
        );
      const committed = { ...event, sequence } as MissionEvent<T>;
      this.projections?.apply(committed as MissionEvent);
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
    ).all(missionId, afterSequence) as any[];
    return rows.map(rowToEvent);
  }

  async lastSequence(missionId: string): Promise<number> {
    const row = this.database.db.prepare("SELECT COALESCE(MAX(sequence), 0) AS seq FROM mission_events WHERE mission_id = ?")
      .get(missionId) as { seq: number };
    return row.seq;
  }
}

function rowToEvent(row: any): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    type: row.type,
    actor: { type: row.actor_type, ...(row.actor_id ? { id: row.actor_id } : {}) },
    payload: JSON.parse(row.payload_json),
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    schemaVersion: row.schema_version,
    createdAt: row.created_at
  } as MissionEvent;
}
