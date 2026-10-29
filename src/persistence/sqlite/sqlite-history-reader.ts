import type { DatabaseSync } from "node:sqlite";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

export interface MissionHistoryExportQuery {
  afterSequence?: number;
  throughSequence?: number;
  limit?: number;
}

export interface MissionHistoryExportPage {
  format: "mission-events/v1";
  missionId: string;
  afterSequence: number;
  throughSequence: number;
  latestSequenceAtRead: number;
  events: MissionEvent[];
  nextAfterSequence?: number;
  complete: boolean;
}

export interface MissionHistoryRetentionState {
  missionId: string;
  mode: "full-history";
  latestSequence: number;
  latestSnapshotSequence: number;
  projectionCheckpoints: Array<{
    projectionName: string;
    eventSequence: number;
    updatedAt: string;
  }>;
  deletionEligibleThroughSequence: 0;
  deletionReason: string;
}

/**
 * Read-only history/export authority.
 *
 * Export pages use durable Mission Event sequence numbers, not projection-local
 * cursors. Retention diagnostics never authorize deletion: the append-only Event
 * Store remains the recovery/rebuild source of truth until a separately verified
 * archive/restore boundary exists.
 */
export class SqliteHistoryReader {
  private readonly db: DatabaseSync;

  constructor(database: MissionDatabase) {
    this.db = database.db;
  }

  readExportPage(missionId: string, query: MissionHistoryExportQuery = {}): MissionHistoryExportPage | undefined {
    if (!this.missionExists(missionId)) return undefined;

    const afterSequence = boundedSequence(query.afterSequence ?? 0, "history afterSequence");
    const latestSequenceAtRead = this.latestSequence(missionId);
    const requestedThrough = query.throughSequence === undefined
      ? latestSequenceAtRead
      : boundedSequence(query.throughSequence, "history throughSequence");
    const throughSequence = Math.min(requestedThrough, latestSequenceAtRead);
    const limit = boundedLimit(query.limit);

    if (afterSequence >= throughSequence) {
      return {
        format: "mission-events/v1",
        missionId,
        afterSequence,
        throughSequence,
        latestSequenceAtRead,
        events: [],
        complete: true
      };
    }

    const rows = this.db.prepare(`
      SELECT *
      FROM mission_events
      WHERE mission_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(missionId, afterSequence, throughSequence, limit) as unknown as SqliteMissionEventRow[];
    const events = rows.map(rowToMissionEvent);
    assertContiguous(events, afterSequence, throughSequence, limit);

    const lastSequence = events.at(-1)?.sequence ?? afterSequence;
    const complete = lastSequence >= throughSequence;
    return {
      format: "mission-events/v1",
      missionId,
      afterSequence,
      throughSequence,
      latestSequenceAtRead,
      events,
      ...(!complete ? { nextAfterSequence: lastSequence } : {}),
      complete
    };
  }

  readRetentionState(missionId: string): MissionHistoryRetentionState | undefined {
    if (!this.missionExists(missionId)) return undefined;
    const latestSequence = this.latestSequence(missionId);
    const snapshot = this.db.prepare(`
      SELECT COALESCE(MAX(event_sequence), 0) AS sequence
      FROM snapshots
      WHERE mission_id = ?
    `).get(missionId) as { sequence: number };
    const checkpoints = this.db.prepare(`
      SELECT projection_name, event_sequence, updated_at
      FROM rm_projection_checkpoints
      WHERE mission_id = ?
      ORDER BY projection_name ASC
    `).all(missionId) as Array<{
      projection_name: string;
      event_sequence: number;
      updated_at: string;
    }>;

    return {
      missionId,
      mode: "full-history",
      latestSequence,
      latestSnapshotSequence: Number(snapshot.sequence),
      projectionCheckpoints: checkpoints.map(row => ({
        projectionName: row.projection_name,
        eventSequence: Number(row.event_sequence),
        updatedAt: row.updated_at
      })),
      deletionEligibleThroughSequence: 0,
      deletionReason: "Full append-only Mission history is still required for authoritative recovery and projection rebuild. Snapshots and projection checkpoints are diagnostic only and do not authorize event deletion."
    };
  }

  private missionExists(missionId: string): boolean {
    return this.db.prepare(
      "SELECT 1 AS present FROM rm_missions WHERE mission_id = ? LIMIT 1"
    ).get(missionId) !== undefined;
  }

  private latestSequence(missionId: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM mission_events WHERE mission_id = ?"
    ).get(missionId) as { sequence: number };
    return Number(row.sequence);
  }
}

function assertContiguous(
  events: MissionEvent[],
  afterSequence: number,
  throughSequence: number,
  limit: number
): void {
  if (events.length === 0) {
    if (afterSequence < throughSequence) {
      throw new Error(`Mission history export sequence gap after ${afterSequence} through ${throughSequence}`);
    }
    return;
  }
  let expected = afterSequence + 1;
  for (const event of events) {
    if (event.sequence !== expected) {
      throw new Error(`Mission history export sequence gap: expected ${expected}, received ${event.sequence}`);
    }
    expected += 1;
  }
  if (events.length < limit && events.at(-1)!.sequence < throughSequence) {
    throw new Error(
      `Mission history export sequence gap after ${events.at(-1)!.sequence} through ${throughSequence}`
    );
  }
}

function boundedSequence(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? 1000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5000) {
    throw new Error("history export limit must be an integer between 1 and 5000");
  }
  return limit;
}
