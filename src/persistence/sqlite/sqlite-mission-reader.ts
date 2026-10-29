import type { Artifact } from "../../core/domain/artifact.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import type {
  CapabilityAuditRecord,
  CapabilityCostRecord,
  CapabilityTrustRecord
} from "../../core/domain/capability-ledger.ts";
import type { SideEffectOperationStatus, SideEffectOperationView } from "../../core/domain/execution.ts";
import type { MissionEvent, MissionEventType } from "../../core/domain/event.ts";
import type { MissionState } from "../../core/domain/mission.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { Evidence, Gap } from "../../core/domain/verification.ts";
import { initialMissionState } from "../../core/events/state-projector.ts";
import type { MissionJournalView } from "../../core/mission/journal-view.ts";
import type { MissionReadModelReader } from "../../core/mission/mission-reader.ts";
import type { StrategyProposal } from "../../core/planning/deliberation-provider.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

export interface SideEffectQuery {
  operationKey?: string;
  executionId?: string;
  workItemId?: string;
  status?: SideEffectOperationStatus;
  afterSequence?: number;
  limit?: number;
}

export interface AttemptQuery {
  workItemId?: string;
  status?: string;
  afterId?: string;
  limit?: number;
}

export interface ExecutionQuery extends AttemptQuery {
  attemptId?: string;
}

export interface ActivityQuery {
  afterSequence?: number;
  type?: MissionEventType | string;
  limit?: number;
}

export class SqliteMissionReader implements MissionReadModelReader {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) {
    this.database = database;
  }

  async state(missionId: string): Promise<MissionState> {
    const row = this.database.db.prepare(
      "SELECT state_json FROM rm_missions WHERE mission_id = ?"
    ).get(missionId) as { state_json?: string } | undefined;
    return row?.state_json ? JSON.parse(row.state_json) as MissionState : initialMissionState(missionId);
  }

  async journal(missionId: string): Promise<MissionJournalView> {
    const mission = this.database.db.prepare(
      "SELECT user_goal FROM rm_missions WHERE mission_id = ?"
    ).get(missionId) as { user_goal?: string } | undefined;

    const workItems = new Map<string, WorkItem>();
    for (const row of this.rows("rm_work_items", missionId)) {
      const work = JSON.parse(row.data_json) as WorkItem;
      workItems.set(work.id, work);
    }

    const artifacts = new Map<string, Artifact>();
    for (const row of this.database.db.prepare(
      "SELECT data_json FROM rm_artifacts WHERE mission_id = ? ORDER BY id, version"
    ).all(missionId) as Array<{ data_json: string }>) {
      const artifact = JSON.parse(row.data_json) as Artifact;
      artifacts.set(`${artifact.id}@${artifact.version}`, artifact);
    }

    const capabilityNeeds = new Map<string, CapabilityNeed>();
    for (const row of this.rows("rm_capability_needs", missionId)) {
      const need = JSON.parse(row.data_json) as CapabilityNeed;
      capabilityNeeds.set(need.id, need);
    }

    const capabilities = new Map<string, CapabilityDescriptor>();
    for (const row of this.rows("rm_capabilities", missionId)) {
      const capability = JSON.parse(row.data_json) as CapabilityDescriptor;
      capabilities.set(capability.id, capability);
    }

    const gaps = new Map<string, Gap>();
    for (const row of this.rows("rm_gaps", missionId)) {
      const gap = JSON.parse(row.data_json) as Gap;
      gaps.set(gap.id, gap);
    }

    const decisionIds = new Set<string>();
    for (const row of this.database.db.prepare(
      "SELECT id FROM rm_decisions WHERE mission_id = ? ORDER BY id"
    ).all(missionId) as Array<{ id: string }>) {
      decisionIds.add(row.id);
    }

    return {
      missionId,
      userGoal: mission?.user_goal ?? "",
      workItems,
      artifacts,
      capabilityNeeds,
      capabilities,
      gaps,
      decisionIds
    };
  }

  async latestStrategy(missionId: string): Promise<StrategyProposal | undefined> {
    const row = this.database.db.prepare(
      "SELECT strategy_json FROM rm_missions WHERE mission_id = ?"
    ).get(missionId) as { strategy_json?: string | null } | undefined;
    return row?.strategy_json ? JSON.parse(row.strategy_json) as StrategyProposal : undefined;
  }

  readAttempts(missionId: string, query: AttemptQuery = {}): Array<Record<string, unknown>> {
    const clauses = ["mission_id = ?"];
    const params: Array<string | number> = [missionId];
    appendLifecycleFilters(clauses, params, query);
    const limit = boundedLimit(query.limit, "attempt");
    params.push(limit);
    const rows = this.database.db.prepare(`
      SELECT data_json
      FROM rm_attempts
      WHERE ${clauses.join(" AND ")}
      ORDER BY id ASC
      LIMIT ?
    `).all(...params) as unknown as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Record<string, unknown>);
  }

  readExecutions(missionId: string, query: ExecutionQuery = {}): Array<Record<string, unknown>> {
    const clauses = ["mission_id = ?"];
    const params: Array<string | number> = [missionId];
    appendLifecycleFilters(clauses, params, query);
    if (query.attemptId !== undefined) {
      clauses.push("attempt_id = ?");
      params.push(boundedIdentifier(query.attemptId, "execution attemptId"));
    }
    const limit = boundedLimit(query.limit, "execution");
    params.push(limit);
    const rows = this.database.db.prepare(`
      SELECT data_json
      FROM rm_executions
      WHERE ${clauses.join(" AND ")}
      ORDER BY id ASC
      LIMIT ?
    `).all(...params) as unknown as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Record<string, unknown>);
  }

  readActivity(missionId: string, query: ActivityQuery = {}): MissionEvent[] {
    const clauses = ["mission_id = ?"];
    const params: Array<string | number> = [missionId];
    const afterSequence = query.afterSequence ?? 0;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
      throw new Error("activity afterSequence must be a non-negative safe integer");
    }
    clauses.push("sequence > ?");
    params.push(afterSequence);
    if (query.type !== undefined) {
      clauses.push("type = ?");
      params.push(boundedToken(query.type, "activity type"));
    }
    const limit = boundedLimit(query.limit, "activity");
    params.push(limit);
    const rows = this.database.db.prepare(`
      SELECT *
      FROM mission_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY sequence ASC
      LIMIT ?
    `).all(...params) as unknown as SqliteMissionEventRow[];
    return rows.map(rowToMissionEvent);
  }

  readFindings(missionId: string): Array<Record<string, unknown>> {
    return this.rows("rm_findings", missionId).map(row => JSON.parse(row.data_json) as Record<string, unknown>);
  }

  readApprovals(missionId: string): Array<Record<string, unknown>> {
    return this.rows("rm_approvals", missionId).map(row => JSON.parse(row.data_json) as Record<string, unknown>);
  }

  readCapabilityTrust(missionId: string): CapabilityTrustRecord[] {
    return this.ledgerRows("rm_capability_trust", missionId)
      .map(row => JSON.parse(row.data_json) as CapabilityTrustRecord);
  }

  readCapabilityCosts(missionId: string): CapabilityCostRecord[] {
    return this.ledgerRows("rm_capability_cost", missionId)
      .map(row => JSON.parse(row.data_json) as CapabilityCostRecord);
  }

  readCapabilityAudit(missionId: string): CapabilityAuditRecord[] {
    return this.ledgerRows("rm_capability_audit", missionId)
      .map(row => JSON.parse(row.data_json) as CapabilityAuditRecord);
  }

  readEvidence(missionId: string, subjectRef?: string): Evidence[] {
    const sql = subjectRef
      ? "SELECT data_json FROM rm_evidence WHERE mission_id = ? AND subject_ref = ? ORDER BY rowid"
      : "SELECT data_json FROM rm_evidence WHERE mission_id = ? ORDER BY rowid";
    const rows = (subjectRef
      ? this.database.db.prepare(sql).all(missionId, subjectRef)
      : this.database.db.prepare(sql).all(missionId)) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Evidence);
  }

  readSideEffects(missionId: string, query: SideEffectQuery = {}): SideEffectOperationView[] {
    const clauses = ["mission_id = ?"];
    const params: Array<string | number> = [missionId];
    if (query.operationKey) {
      clauses.push("operation_key = ?");
      params.push(query.operationKey);
    }
    if (query.executionId) {
      clauses.push("execution_id = ?");
      params.push(query.executionId);
    }
    if (query.workItemId) {
      clauses.push("work_item_id = ?");
      params.push(query.workItemId);
    }
    if (query.status) {
      clauses.push("status = ?");
      params.push(query.status);
    }
    if (query.afterSequence !== undefined) {
      if (!Number.isSafeInteger(query.afterSequence) || query.afterSequence < 0) {
        throw new Error("side-effect afterSequence must be a non-negative safe integer");
      }
      clauses.push("last_event_sequence > ?");
      params.push(query.afterSequence);
    }
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("side-effect query limit must be an integer between 1 and 500");
    }
    params.push(limit);

    const rows = this.database.db.prepare(`
      SELECT intent_json, admission_json, replay_block_json, replay_block_count,
             completion_json, status, last_event_sequence, updated_at
      FROM rm_side_effects
      WHERE ${clauses.join(" AND ")}
      ORDER BY last_event_sequence ASC, operation_key ASC
      LIMIT ?
    `).all(...params) as unknown as Array<{
      intent_json: string;
      admission_json: string | null;
      replay_block_json: string | null;
      replay_block_count: number;
      completion_json: string | null;
      status: SideEffectOperationStatus;
      last_event_sequence: number;
      updated_at: string;
    }>;

    return rows.map(row => {
      const intent = JSON.parse(row.intent_json) as SideEffectOperationView["intent"];
      return {
        missionId,
        operationKey: intent.operationKey,
        intent,
        ...(row.admission_json ? { admission: JSON.parse(row.admission_json) as SideEffectOperationView["admission"] } : {}),
        ...(row.replay_block_json ? {
          lastReplayBlocked: JSON.parse(row.replay_block_json) as SideEffectOperationView["lastReplayBlocked"]
        } : {}),
        replayBlockCount: row.replay_block_count,
        ...(row.completion_json ? { completion: JSON.parse(row.completion_json) as SideEffectOperationView["completion"] } : {}),
        status: row.status,
        lastEventSequence: row.last_event_sequence,
        updatedAt: row.updated_at
      };
    });
  }

  private ledgerRows(
    table: "rm_capability_trust" | "rm_capability_cost" | "rm_capability_audit",
    missionId: string
  ): Array<{ data_json: string }> {
    // Ledger rows are inserted by the transactional projector strictly in
    // Mission Event sequence order. Use rowid rather than wall-clock fields so
    // clock skew cannot invert audit history. Rebuilds replay the same event
    // sequence and therefore reproduce the same ordering.
    return this.database.db.prepare(
      `SELECT data_json FROM ${table} WHERE mission_id = ? ORDER BY rowid`
    ).all(missionId) as Array<{ data_json: string }>;
  }

  private rows(
    table:
      | "rm_work_items"
      | "rm_findings"
      | "rm_gaps"
      | "rm_decisions"
      | "rm_approvals"
      | "rm_capability_needs"
      | "rm_capabilities",
    missionId: string
  ): Array<{ data_json: string }> {
    return this.database.db.prepare(
      `SELECT data_json FROM ${table} WHERE mission_id = ? ORDER BY id`
    ).all(missionId) as Array<{ data_json: string }>;
  }
}

function appendLifecycleFilters(
  clauses: string[],
  params: Array<string | number>,
  query: AttemptQuery
): void {
  if (query.workItemId !== undefined) {
    clauses.push("work_item_id = ?");
    params.push(boundedIdentifier(query.workItemId, "workItemId"));
  }
  if (query.status !== undefined) {
    clauses.push("status = ?");
    params.push(boundedToken(query.status, "lifecycle status"));
  }
  if (query.afterId !== undefined) {
    clauses.push("id > ?");
    params.push(boundedIdentifier(query.afterId, "afterId"));
  }
}

function boundedLimit(value: number | undefined, label: string): number {
  const limit = value ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error(`${label} query limit must be an integer between 1 and 500`);
  }
  return limit;
}

function boundedIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256) throw new Error(`${label} must be between 1 and 256 characters`);
  return normalized;
}

function boundedToken(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(normalized)) {
    throw new Error(`${label} must be a bounded token`);
  }
  return normalized;
}
