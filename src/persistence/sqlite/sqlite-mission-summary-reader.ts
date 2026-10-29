import type { MissionStatus } from "../../core/domain/mission.ts";
import type { MissionDatabase } from "./database.ts";

export interface MissionOperationalSummary {
  missionId: string;
  status: MissionStatus;
  eventSequence: number;
  generatedAt: string;
  firstEventAt?: string;
  lastEventAt?: string;
  missionAgeMs?: number;
  idleMs?: number;
  eventThroughput: {
    last5Minutes: number;
    last60Minutes: number;
  };
  counts: {
    workItemsByStatus: Record<string, number>;
    attemptsByStatus: Record<string, number>;
    executionsByStatus: Record<string, number>;
    artifactsByStatus: Record<string, number>;
    gapsByStatus: Record<string, number>;
    approvalsByStatus: Record<string, number>;
    sideEffectsByStatus: Record<string, number>;
    evidenceByResult: Record<string, number>;
    findings: number;
    activeCapabilities: number;
    sideEffectReplayBlocks: number;
  };
  completedExecutionLatencyMs: {
    samples: number;
    average: number | null;
    minimum: number | null;
    maximum: number | null;
  };
}

type GroupedTable =
  | "rm_work_items"
  | "rm_attempts"
  | "rm_executions"
  | "rm_artifacts"
  | "rm_gaps"
  | "rm_approvals"
  | "rm_side_effects";

export class SqliteMissionSummaryReader {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) {
    this.database = database;
  }

  readSummary(missionId: string, now: Date = new Date()): MissionOperationalSummary | undefined {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Mission summary requires a valid current time");

    const mission = this.database.db.prepare(`
      SELECT event_sequence, state_json
      FROM rm_missions
      WHERE mission_id = ?
    `).get(missionId) as { event_sequence: number; state_json: string } | undefined;
    if (!mission) return undefined;

    const state = JSON.parse(mission.state_json) as { status?: unknown };
    if (typeof state.status !== "string") throw new Error(`Mission summary state is missing status: ${missionId}`);

    const eventBounds = this.database.db.prepare(`
      SELECT MIN(created_at) AS first_event_at, MAX(created_at) AS last_event_at
      FROM mission_events
      WHERE mission_id = ?
    `).get(missionId) as { first_event_at: string | null; last_event_at: string | null };

    const cutoff5 = new Date(nowMs - 5 * 60_000).toISOString();
    const cutoff60 = new Date(nowMs - 60 * 60_000).toISOString();
    const throughput = this.database.db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_5_minutes,
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_60_minutes
      FROM mission_events
      WHERE mission_id = ?
    `).get(cutoff5, cutoff60, missionId) as {
      last_5_minutes: number | null;
      last_60_minutes: number | null;
    };

    const evidenceByResult = groupedRows(this.database, `
      SELECT result AS key, COUNT(*) AS count
      FROM rm_evidence
      WHERE mission_id = ?
      GROUP BY result
      ORDER BY result
    `, missionId);

    const findings = scalarCount(this.database, "rm_findings", missionId);
    const activeCapabilities = scalarCount(this.database, "rm_capabilities", missionId);
    const replay = this.database.db.prepare(`
      SELECT COALESCE(SUM(replay_block_count), 0) AS count
      FROM rm_side_effects
      WHERE mission_id = ?
    `).get(missionId) as { count: number };

    const latency = this.database.db.prepare(`
      SELECT
        COUNT(*) AS samples,
        AVG((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS average_ms,
        MIN((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS minimum_ms,
        MAX((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS maximum_ms
      FROM rm_executions
      WHERE mission_id = ?
        AND status = 'completed'
        AND json_type(data_json, '$.startedAt') = 'text'
        AND json_type(data_json, '$.endedAt') = 'text'
        AND julianday(json_extract(data_json, '$.endedAt')) >= julianday(json_extract(data_json, '$.startedAt'))
    `).get(missionId) as {
      samples: number;
      average_ms: number | null;
      minimum_ms: number | null;
      maximum_ms: number | null;
    };

    const firstEventAt = eventBounds.first_event_at ?? undefined;
    const lastEventAt = eventBounds.last_event_at ?? undefined;
    const firstEventMs = firstEventAt ? Date.parse(firstEventAt) : Number.NaN;
    const lastEventMs = lastEventAt ? Date.parse(lastEventAt) : Number.NaN;

    return {
      missionId,
      status: state.status as MissionStatus,
      eventSequence: mission.event_sequence,
      generatedAt: now.toISOString(),
      ...(firstEventAt ? { firstEventAt } : {}),
      ...(lastEventAt ? { lastEventAt } : {}),
      ...(Number.isFinite(firstEventMs) ? { missionAgeMs: Math.max(0, nowMs - firstEventMs) } : {}),
      ...(Number.isFinite(lastEventMs) ? { idleMs: Math.max(0, nowMs - lastEventMs) } : {}),
      eventThroughput: {
        last5Minutes: Number(throughput.last_5_minutes ?? 0),
        last60Minutes: Number(throughput.last_60_minutes ?? 0)
      },
      counts: {
        workItemsByStatus: this.groupByStatus("rm_work_items", missionId),
        attemptsByStatus: this.groupByStatus("rm_attempts", missionId),
        executionsByStatus: this.groupByStatus("rm_executions", missionId),
        artifactsByStatus: this.groupByStatus("rm_artifacts", missionId),
        gapsByStatus: this.groupByStatus("rm_gaps", missionId),
        approvalsByStatus: this.groupByStatus("rm_approvals", missionId),
        sideEffectsByStatus: this.groupByStatus("rm_side_effects", missionId),
        evidenceByResult,
        findings,
        activeCapabilities,
        sideEffectReplayBlocks: Number(replay.count ?? 0)
      },
      completedExecutionLatencyMs: {
        samples: Number(latency.samples ?? 0),
        average: roundedNullable(latency.average_ms),
        minimum: roundedNullable(latency.minimum_ms),
        maximum: roundedNullable(latency.maximum_ms)
      }
    };
  }

  private groupByStatus(table: GroupedTable, missionId: string): Record<string, number> {
    return groupedRows(this.database, `
      SELECT status AS key, COUNT(*) AS count
      FROM ${table}
      WHERE mission_id = ?
      GROUP BY status
      ORDER BY status
    `, missionId);
  }
}

function groupedRows(database: MissionDatabase, sql: string, missionId: string): Record<string, number> {
  const rows = database.db.prepare(sql).all(missionId) as unknown as Array<{ key: string; count: number }>;
  const result: Record<string, number> = {};
  for (const row of rows) result[row.key] = Number(row.count);
  return result;
}

function scalarCount(database: MissionDatabase, table: "rm_findings" | "rm_capabilities", missionId: string): number {
  const row = database.db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE mission_id = ?`)
    .get(missionId) as { count: number };
  return Number(row.count);
}

function roundedNullable(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value);
}
