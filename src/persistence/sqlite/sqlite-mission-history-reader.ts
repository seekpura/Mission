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
  complete: boolean;
  nextAfterSequence?: number;
}

export interface MissionHistoryRetentionState {
  missionId: string;
  policy: "full-history-required";
  latestSequence: number;
  oldestRetainedSequence: number;
  retainedEventCount: number;
  fullHistoryPresent: boolean;
  latestSnapshotSequence: number;
  minimumProjectionCheckpointSequence: number;
  maximumProjectionCheckpointSequence: number;
  deletionEligibleThroughSequence: 0;
  reason: string;
}

/**
 * Bounded history export and retention diagnostics.
 *
 * Exporting a Mission prefix does not authorize deletion. The append-only
 * Mission Event Store remains the authoritative rebuild/recovery source until
 * a separately verified archive/restore boundary is implemented.
 */
export class SqliteMissionHistoryReader {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) {
    this.database = database;
  }

  readExportPage(
    missionId: string,
    query: MissionHistoryExportQuery = {}
  ): MissionHistoryExportPage | undefined {
    const mission = this.database.db.prepare(
      "SELECT event_sequence FROM rm_missions WHERE mission_id = ?"
    ).get(missionId) as { event_sequence: number } | undefined;
    if (!mission) return undefined;

    const latestSequenceAtRead = Number(mission.event_sequence);
    const afterSequence = boundedSequence(query.afterSequence ?? 0, "history afterSequence");
    const requestedThrough = boundedSequence(
      query.throughSequence ?? latestSequenceAtRead,
      "history throughSequence"
    );
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

    const rows = this.database.db.prepare(`
      SELECT *
      FROM mission_events
      WHERE mission_id = ? AND sequence > ? AND sequence <= ?
      ORDER BY sequence ASC
      LIMIT ?
    `).all(missionId, afterSequence, throughSequence, limit + 1) as unknown as SqliteMissionEventRow[];

    assertContiguous(rows, afterSequence, missionId);
    const hasMore = rows.length > limit;
    const visibleRows = hasMore ? rows.slice(0, limit) : rows;
    const events = visibleRows.map(rowToMissionEvent);
    const lastSequence = events.at(-1)?.sequence ?? afterSequence;

    if (!hasMore && lastSequence !== throughSequence) {
      throw new Error(
        `Mission history export is incomplete for ${missionId}: ended at ${lastSequence}, expected ${throughSequence}`
      );
    }

    return {
      format: "mission-events/v1",
      missionId,
      afterSequence,
      throughSequence,
      latestSequenceAtRead,
      events,
      complete: !hasMore,
      ...(hasMore ? { nextAfterSequence: lastSequence } : {})
    };
  }

  readRetentionState(missionId: string): MissionHistoryRetentionState | undefined {
    const mission = this.database.db.prepare(
      "SELECT event_sequence FROM rm_missions WHERE mission_id = ?"
    ).get(missionId) as { event_sequence: number } | undefined;
    if (!mission) return undefined;

    const latestSequence = Number(mission.event_sequence);
    const retained = this.database.db.prepare(`
      SELECT MIN(sequence) AS oldest_sequence, COUNT(*) AS event_count
      FROM mission_events
      WHERE mission_id = ?
    `).get(missionId) as { oldest_sequence: number | null; event_count: number };
    const snapshot = this.database.db.prepare(`
      SELECT COALESCE(MAX(event_sequence), 0) AS sequence
      FROM snapshots
      WHERE mission_id = ?
    `).get(missionId) as { sequence: number };
    const checkpoints = this.database.db.prepare(`
      SELECT
        COALESCE(MIN(event_sequence), 0) AS minimum_sequence,
        COALESCE(MAX(event_sequence), 0) AS maximum_sequence
      FROM rm_projection_checkpoints
      WHERE mission_id = ?
    `).get(missionId) as { minimum_sequence: number; maximum_sequence: number };

    const oldestRetainedSequence = Number(retained.oldest_sequence ?? 0);
    const retainedEventCount = Number(retained.event_count);
    const fullHistoryPresent = latestSequence === 0
      ? retainedEventCount === 0
      : oldestRetainedSequence === 1 && retainedEventCount === latestSequence;

    return {
      missionId,
      policy: "full-history-required",
      latestSequence,
      oldestRetainedSequence,
      retainedEventCount,
      fullHistoryPresent,
      latestSnapshotSequence: Number(snapshot.sequence),
      minimumProjectionCheckpointSequence: Number(checkpoints.minimum_sequence),
      maximumProjectionCheckpointSequence: Number(checkpoints.maximum_sequence),
      deletionEligibleThroughSequence: 0,
      reason: "Complete append-only Mission Event history remains required for authoritative rebuild and recovery; snapshots and projection checkpoints are diagnostic only and do not authorize deletion."
    };
  }
}

function assertContiguous(rows: SqliteMissionEventRow[], afterSequence: number, missionId: string): void {
  let expected = afterSequence + 1;
  for (const row of rows) {
    if (row.sequence !== expected) {
      throw new Error(
        `Mission history export sequence gap for ${missionId}: expected ${expected}, found ${row.sequence}`
      );
    }
    expected += 1;
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
