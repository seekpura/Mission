import type { DatabaseSync } from "node:sqlite";
import type { MissionDatabase } from "./database.ts";

export interface ExecutionLatencySummary {
  sampleCount: number;
  averageMs?: number;
  minimumMs?: number;
  maximumMs?: number;
}

export interface MissionOperationalSummary {
  missionId: string;
  status: string;
  eventSequence: number;
  observedAt: string;
  missionAgeMs?: number;
  idleMs?: number;
  eventThroughput: {
    last5Minutes: number;
    last60Minutes: number;
  };
  workItems: Record<string, number>;
  attempts: Record<string, number>;
  executions: Record<string, number>;
  artifacts: Record<string, number>;
  gaps: Record<string, number>;
  approvals: Record<string, number>;
  sideEffects: Record<string, number>;
  evidence: Record<string, number>;
  findingCount: number;
  activeCapabilityCount: number;
  replayBlockCount: number;
  completedExecutionLatencyMs: ExecutionLatencySummary;
}

/**
 * Operator-facing aggregate view for long-lived Missions.
 *
 * This deliberately returns only SQL aggregates/current projection state. It
 * does not materialize raw Mission history and it is not a recovery boundary.
 */
export class SqliteOperationalSummaryReader {
  private readonly db: DatabaseSync;

  constructor(database: MissionDatabase) {
    this.db = database.db;
  }

  readSummary(missionId: string, observedAt: Date = new Date()): MissionOperationalSummary | undefined {
    const mission = this.db.prepare(`
      SELECT event_sequence, state_json, created_at, updated_at
      FROM rm_missions
      WHERE mission_id = ?
    `).get(missionId) as {
      event_sequence: number;
      state_json: string;
      created_at: string | null;
      updated_at: string;
    } | undefined;
    if (!mission) return undefined;

    const nowMs = observedAt.getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Operational summary requires a valid observation time");
    const observedAtIso = observedAt.toISOString();
    const fiveMinutesAgo = new Date(nowMs - 5 * 60_000).toISOString();
    const sixtyMinutesAgo = new Date(nowMs - 60 * 60_000).toISOString();
    const state = JSON.parse(mission.state_json) as { status?: unknown };
    const status = typeof state.status === "string" ? state.status : "unknown";

    const throughput = this.db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS last_5,
        COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END), 0) AS last_60
      FROM mission_events
      WHERE mission_id = ?
    `).get(fiveMinutesAgo, sixtyMinutesAgo, missionId) as { last_5: number; last_60: number };

    const sideEffectReplay = this.db.prepare(`
      SELECT COALESCE(SUM(replay_block_count), 0) AS replay_blocks
      FROM rm_side_effects
      WHERE mission_id = ?
    `).get(missionId) as { replay_blocks: number };

    const finding = this.db.prepare(
      "SELECT COUNT(*) AS count FROM rm_findings WHERE mission_id = ?"
    ).get(missionId) as { count: number };
    const capability = this.db.prepare(
      "SELECT COUNT(*) AS count FROM rm_capabilities WHERE mission_id = ?"
    ).get(missionId) as { count: number };

    const latency = this.db.prepare(`
      SELECT
        COUNT(*) AS sample_count,
        AVG((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS average_ms,
        MIN((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS minimum_ms,
        MAX((julianday(json_extract(data_json, '$.endedAt')) - julianday(json_extract(data_json, '$.startedAt'))) * 86400000.0) AS maximum_ms
      FROM rm_executions
      WHERE mission_id = ?
        AND status = 'completed'
        AND json_extract(data_json, '$.startedAt') IS NOT NULL
        AND json_extract(data_json, '$.endedAt') IS NOT NULL
    `).get(missionId) as {
      sample_count: number;
      average_ms: number | null;
      minimum_ms: number | null;
      maximum_ms: number | null;
    };

    return {
      missionId,
      status,
      eventSequence: mission.event_sequence,
      observedAt: observedAtIso,
      ...durationFields(nowMs, mission.created_at, mission.updated_at),
      eventThroughput: {
        last5Minutes: Number(throughput.last_5),
        last60Minutes: Number(throughput.last_60)
      },
      workItems: this.statusCounts("rm_work_items", missionId),
      attempts: this.statusCounts("rm_attempts", missionId),
      executions: this.statusCounts("rm_executions", missionId),
      artifacts: this.statusCounts("rm_artifacts", missionId),
      gaps: this.statusCounts("rm_gaps", missionId),
      approvals: this.statusCounts("rm_approvals", missionId),
      sideEffects: this.statusCounts("rm_side_effects", missionId),
      evidence: this.resultCounts(missionId),
      findingCount: Number(finding.count),
      activeCapabilityCount: Number(capability.count),
      replayBlockCount: Number(sideEffectReplay.replay_blocks),
      completedExecutionLatencyMs: latencySummary(latency)
    };
  }

  private statusCounts(
    table: "rm_work_items" | "rm_attempts" | "rm_executions" | "rm_artifacts" | "rm_gaps" | "rm_approvals" | "rm_side_effects",
    missionId: string
  ): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM ${table}
      WHERE mission_id = ?
      GROUP BY status
      ORDER BY status
    `).all(missionId) as Array<{ status: string; count: number }>;
    return Object.fromEntries(rows.map(row => [row.status, Number(row.count)]));
  }

  private resultCounts(missionId: string): Record<string, number> {
    const rows = this.db.prepare(`
      SELECT result, COUNT(*) AS count
      FROM rm_evidence
      WHERE mission_id = ?
      GROUP BY result
      ORDER BY result
    `).all(missionId) as Array<{ result: string; count: number }>;
    return Object.fromEntries(rows.map(row => [row.result, Number(row.count)]));
  }
}

function durationFields(
  nowMs: number,
  createdAt: string | null,
  updatedAt: string
): Pick<MissionOperationalSummary, "missionAgeMs" | "idleMs"> {
  const createdMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const updatedMs = Date.parse(updatedAt);
  return {
    ...(Number.isFinite(createdMs) ? { missionAgeMs: Math.max(0, nowMs - createdMs) } : {}),
    ...(Number.isFinite(updatedMs) ? { idleMs: Math.max(0, nowMs - updatedMs) } : {})
  };
}

function latencySummary(row: {
  sample_count: number;
  average_ms: number | null;
  minimum_ms: number | null;
  maximum_ms: number | null;
}): ExecutionLatencySummary {
  const sampleCount = Number(row.sample_count);
  if (sampleCount === 0) return { sampleCount: 0 };
  return {
    sampleCount,
    averageMs: roundedDuration(row.average_ms),
    minimumMs: roundedDuration(row.minimum_ms),
    maximumMs: roundedDuration(row.maximum_ms)
  };
}

function roundedDuration(value: number | null): number {
  if (value === null || !Number.isFinite(value)) throw new Error("Invalid completed execution latency aggregate");
  return Math.max(0, Math.round(value));
}
