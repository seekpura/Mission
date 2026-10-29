import type { DatabaseSync } from "node:sqlite";
import type {
  SideEffectAdmission,
  SideEffectCompletion,
  SideEffectIntent
} from "../../core/domain/execution.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

const PROJECTION_NAME = "side-effect-read-model-v1";

/**
 * Dedicated operational projection for Runtime side-effect lifecycle state.
 *
 * Side-effect admission/replay decisions are safety-critical and can become
 * high-volume on long-lived Missions. Keeping a current operation view avoids
 * reconstructing every query from the append-only Mission event log while the
 * event log remains the source of truth and rebuild path.
 */
export class SqliteSideEffectProjector {
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
        `Side-effect projection sequence gap for ${event.missionId}: checkpoint=${checkpoint}, event=${event.sequence}`
      );
    }

    switch (event.type) {
      case "side_effect.intent.recorded":
        this.recordIntent(event);
        break;
      case "side_effect.admitted":
      case "side_effect.denied":
        this.recordAdmission(event);
        break;
      case "side_effect.replay_blocked":
        this.recordReplayBlock(event);
        break;
      case "side_effect.completed":
      case "side_effect.failed":
        this.recordCompletion(event);
        break;
    }

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

  private recordIntent(event: MissionEvent): void {
    const intent = validateIntent(event);
    try {
      this.db.prepare(`
        INSERT INTO rm_side_effects (
          mission_id, operation_key, intent_id, work_item_id, attempt_id, execution_id,
          source, effect_class, effect_type, target, status, intent_json,
          replay_block_count, created_at, updated_at, last_event_sequence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)
      `).run(
        intent.missionId,
        intent.operationKey,
        intent.id,
        intent.workItemId ?? null,
        intent.attemptId ?? null,
        intent.executionId ?? null,
        intent.source,
        intent.effectClass,
        intent.type,
        intent.target,
        JSON.stringify(intent),
        intent.createdAt,
        event.createdAt,
        event.sequence
      );
    } catch (error) {
      if (isConstraintError(error)) {
        throw new Error(`Duplicate side-effect intent operation key ${intent.operationKey}`);
      }
      throw error;
    }
  }

  private recordAdmission(event: MissionEvent): void {
    const admission = validateAdmission(event);
    const changed = this.db.prepare(`
      UPDATE rm_side_effects
      SET admission_status = ?, admission_json = ?, status = ?, updated_at = ?, last_event_sequence = ?
      WHERE mission_id = ? AND operation_key = ? AND intent_id = ?
        AND admission_json IS NULL AND completion_json IS NULL
    `).run(
      admission.status,
      JSON.stringify(admission),
      admission.status,
      event.createdAt,
      event.sequence,
      event.missionId,
      admission.operationKey,
      admission.intentId
    );
    if (Number(changed.changes) !== 1) {
      throw new Error(`Side-effect admission references unknown or invalid lifecycle intent ${admission.intentId}`);
    }
  }

  private recordReplayBlock(event: MissionEvent): void {
    const admission = validateAdmission(event);
    if (admission.status !== "replay_blocked") {
      throw new Error("side_effect.replay_blocked requires replay_blocked admission status");
    }
    const changed = this.db.prepare(`
      UPDATE rm_side_effects
      SET replay_block_json = ?, replay_block_count = replay_block_count + 1,
          updated_at = ?, last_event_sequence = ?
      WHERE mission_id = ? AND operation_key = ? AND intent_id = ?
        AND admission_status = 'admitted'
    `).run(
      JSON.stringify(admission),
      event.createdAt,
      event.sequence,
      event.missionId,
      admission.operationKey,
      admission.intentId
    );
    if (Number(changed.changes) !== 1) {
      throw new Error(`Side-effect replay block references unknown or non-admitted intent ${admission.intentId}`);
    }
  }

  private recordCompletion(event: MissionEvent): void {
    const completion = validateCompletion(event);
    const changed = this.db.prepare(`
      UPDATE rm_side_effects
      SET completion_status = ?, completion_json = ?, status = ?, updated_at = ?, last_event_sequence = ?
      WHERE mission_id = ? AND operation_key = ? AND intent_id = ?
        AND admission_status = 'admitted' AND completion_json IS NULL
    `).run(
      completion.status,
      JSON.stringify(completion),
      completion.status,
      event.createdAt,
      event.sequence,
      event.missionId,
      completion.operationKey,
      completion.intentId
    );
    if (Number(changed.changes) !== 1) {
      throw new Error(`Side-effect completion references unknown, non-admitted or terminal intent ${completion.intentId}`);
    }
  }
}

function validateIntent(event: MissionEvent): SideEffectIntent {
  const value = objectPayload(event, "side_effect.intent.recorded") as Partial<SideEffectIntent>;
  if (value.missionId !== event.missionId) throw new Error("Side-effect intent mission mismatch");
  requiredString(value.id, "sideEffect.intent.id");
  requiredString(value.operationKey, "sideEffect.intent.operationKey");
  requiredString(value.fingerprint, "sideEffect.intent.fingerprint");
  requiredString(value.source, "sideEffect.intent.source");
  requiredString(value.effectClass, "sideEffect.intent.effectClass");
  requiredString(value.type, "sideEffect.intent.type");
  requiredString(value.target, "sideEffect.intent.target");
  requiredString(value.description, "sideEffect.intent.description");
  requiredString(value.createdAt, "sideEffect.intent.createdAt");
  if (typeof value.reversible !== "boolean") throw new Error("Side-effect intent reversible must be boolean");
  return structuredClone(value as SideEffectIntent);
}

function validateAdmission(event: MissionEvent): SideEffectAdmission {
  const value = objectPayload(event, event.type) as Partial<SideEffectAdmission>;
  requiredString(value.intentId, "sideEffect.admission.intentId");
  requiredString(value.operationKey, "sideEffect.admission.operationKey");
  requiredString(value.reason, "sideEffect.admission.reason");
  requiredString(value.decidedAt, "sideEffect.admission.decidedAt");
  if (value.status !== "admitted" && value.status !== "denied" && value.status !== "replay_blocked") {
    throw new Error(`Unsupported side-effect admission status: ${String(value.status)}`);
  }
  if (typeof value.approvalRequired !== "boolean") {
    throw new Error("Side-effect admission approvalRequired must be boolean");
  }
  if (event.type === "side_effect.admitted" && value.status !== "admitted") {
    throw new Error("side_effect.admitted requires admitted status");
  }
  if (event.type === "side_effect.denied" && value.status !== "denied") {
    throw new Error("side_effect.denied requires denied status");
  }
  return structuredClone(value as SideEffectAdmission);
}

function validateCompletion(event: MissionEvent): SideEffectCompletion {
  const value = objectPayload(event, event.type) as Partial<SideEffectCompletion>;
  requiredString(value.intentId, "sideEffect.completion.intentId");
  requiredString(value.operationKey, "sideEffect.completion.operationKey");
  requiredString(value.completedAt, "sideEffect.completion.completedAt");
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "unknown") {
    throw new Error(`Unsupported side-effect completion status: ${String(value.status)}`);
  }
  if (event.type === "side_effect.failed" && value.status !== "failed") {
    throw new Error("side_effect.failed requires failed completion status");
  }
  if (event.type === "side_effect.completed" && value.status === "failed") {
    throw new Error("side_effect.completed cannot carry failed completion status");
  }
  return structuredClone(value as SideEffectCompletion);
}

function objectPayload(event: MissionEvent, type: string): Record<string, unknown> {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error(`${type} requires an object payload`);
  }
  return event.payload as Record<string, unknown>;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string at ${path}`);
  return value;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(`${error.name} ${error.message}`);
}
