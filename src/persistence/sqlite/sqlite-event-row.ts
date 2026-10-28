import type { MissionEvent } from "../../core/domain/event.ts";

export interface SqliteMissionEventRow {
  id: string;
  mission_id: string;
  sequence: number;
  type: string;
  actor_type: string;
  actor_id: string | null;
  payload_json: string;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  schema_version: number;
  created_at: string;
}

export function rowToMissionEvent(row: SqliteMissionEventRow): MissionEvent {
  return {
    id: row.id,
    missionId: row.mission_id,
    sequence: row.sequence,
    type: row.type as MissionEvent["type"],
    actor: {
      type: row.actor_type as MissionEvent["actor"]["type"],
      ...(row.actor_id ? { id: row.actor_id } : {})
    },
    payload: JSON.parse(row.payload_json),
    ...(row.causation_id ? { causationId: row.causation_id } : {}),
    ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
    ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    schemaVersion: row.schema_version,
    createdAt: row.created_at
  };
}
