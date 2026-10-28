import type { DatabaseSync } from "node:sqlite";
import type { Artifact, ArtifactStatus } from "../../core/domain/artifact.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionState } from "../../core/domain/mission.ts";
import type { Gap } from "../../core/domain/verification.ts";
import type { WorkItem, WorkStatus } from "../../core/domain/work-item.ts";
import { applyMissionEvent, initialMissionState } from "../../core/events/state-projector.ts";
import { projectMissionJournal } from "../../core/mission/journal-view.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

const PROJECTION_NAME = "mission-read-model-v1";

export class SqliteReadModelProjector {
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

  /** Caller must already own the SQLite write transaction when used from append. */
  catchUpMission(missionId: string): void {
    const checkpoint = this.checkpoint(missionId);
    const rows = this.db.prepare(
      "SELECT * FROM mission_events WHERE mission_id = ? AND sequence > ? ORDER BY sequence ASC"
    ).all(missionId, checkpoint) as unknown as SqliteMissionEventRow[];
    for (const row of rows) this.applyEvent(rowToMissionEvent(row));
  }

  /** Caller must already own the SQLite write transaction. */
  applyEvent(event: MissionEvent): void {
    const checkpoint = this.checkpoint(event.missionId);
    if (event.sequence <= checkpoint) return;
    if (event.sequence !== checkpoint + 1) {
      throw new Error(
        `Read-model projection sequence gap for ${event.missionId}: checkpoint=${checkpoint}, event=${event.sequence}`
      );
    }

    this.projectMission(event);
    this.projectEntity(event);
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

  private projectMission(event: MissionEvent): void {
    const row = this.db.prepare(
      "SELECT user_goal, strategy_json, state_json, created_at FROM rm_missions WHERE mission_id = ?"
    ).get(event.missionId) as {
      user_goal: string;
      strategy_json: string | null;
      state_json: string;
      created_at: string | null;
    } | undefined;

    const state = row ? JSON.parse(row.state_json) as MissionState : initialMissionState(event.missionId);
    applyMissionEvent(state, event);
    let userGoal = row?.user_goal ?? "";
    let strategyJson = row?.strategy_json ?? null;
    if (event.type === "mission.created") {
      const value = (event.payload as { userGoal?: unknown }).userGoal;
      if (typeof value === "string") userGoal = value;
    }
    if (event.type === "strategy.created" || event.type === "strategy.revised") {
      strategyJson = JSON.stringify(event.payload);
    }
    const createdAt = row?.created_at ?? state.createdAt ?? event.createdAt;

    this.db.prepare(`
      INSERT INTO rm_missions
        (mission_id, user_goal, strategy_json, event_sequence, state_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        user_goal = excluded.user_goal,
        strategy_json = excluded.strategy_json,
        event_sequence = excluded.event_sequence,
        state_json = excluded.state_json,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `).run(
      event.missionId,
      userGoal,
      strategyJson,
      event.sequence,
      JSON.stringify(state),
      createdAt,
      event.createdAt
    );
  }

  private projectEntity(event: MissionEvent): void {
    switch (event.type) {
      case "mission.spec.revised": {
        const payload = objectPayload(event);
        const revision = numberField(payload, "revision");
        this.db.prepare(`
          INSERT OR REPLACE INTO mission_specs (mission_id, revision, data_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(event.missionId, revision, JSON.stringify(payload), event.createdAt);
        return;
      }
      case "acceptance.created":
      case "acceptance.revised": {
        const payload = objectPayload(event);
        const revision = numberField(payload, "revision");
        this.db.prepare(`
          INSERT OR REPLACE INTO acceptance_contracts (mission_id, revision, data_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(event.missionId, revision, JSON.stringify(payload), event.createdAt);
        return;
      }
      case "work.created":
        return this.createWork(event);
      case "work.started":
        return this.updateWork(event, "running");
      case "work.completed":
        return this.updateWork(event, "succeeded");
      case "work.failed":
        return this.updateWork(event, "failed");
      case "work.blocked":
        return this.updateWork(event, "blocked");
      case "work.invalidated":
        return this.updateWork(event, "invalidated");
      case "work.updated": {
        const payload = objectPayload(event);
        return this.updateWork(event, typeof payload.status === "string" ? payload.status as WorkStatus : undefined, payload.work);
      }
      case "attempt.created":
        return this.createAttempt(event);
      case "attempt.completed":
        return this.updateAttempt(event, stringField(objectPayload(event), "status"));
      case "execution.created":
        return this.createExecution(event);
      case "execution.started":
        return this.updateExecution(event, "running");
      case "execution.bound":
        return this.updateExecution(event, "running");
      case "execution.recovery.started":
        return this.updateExecution(event, "recovering");
      case "execution.completed":
        return this.updateExecution(event, "completed");
      case "execution.failed":
        return this.updateExecution(event, "failed");
      case "execution.lost":
        return this.updateExecution(event, "lost");
      case "execution.cancelled":
        return this.updateExecution(event, "cancelled");
      case "artifact.created":
        return this.createArtifact(event);
      case "artifact.validated": {
        const payload = objectPayload(event);
        return this.updateArtifactStatus(event, stringField(payload, "artifactRef"), payload.final ? "final" : "verified");
      }
      case "artifact.invalidated":
        return this.updateArtifactStatus(event, stringField(objectPayload(event), "artifactRef"), "invalid");
      case "artifact.superseded":
        return this.updateArtifactStatus(event, stringField(objectPayload(event), "artifactRef"), "superseded");
      case "finding.created":
        return this.createFinding(event);
      case "gap.opened":
        return this.createGap(event);
      case "gap.resolved":
        return this.updateGap(event, "resolved");
      case "gap.accepted":
        return this.updateGap(event, "accepted");
      case "decision.created":
        return this.createDecision(event);
      case "decision.applied":
        return this.updateDecision(event, "applied");
      case "approval.requested":
        return this.createApproval(event);
      case "approval.decided":
        return this.updateApproval(event);
      case "capability.need.created":
        return this.createCapabilityNeed(event);
      case "capability.activated":
        return this.createCapability(event);
      case "capability.deactivated":
      case "capability.revoked":
      case "capability.rejected":
        return this.removeCapability(event);
      case "capability.trust.recorded":
        return this.createCapabilityTrust(event);
      case "capability.cost.recorded":
        return this.createCapabilityCost(event);
      case "capability.audit.recorded":
        return this.createCapabilityAudit(event);
    }
  }

  private createWork(event: MissionEvent): void {
    const projected = projectMissionJournal(event.missionId, [event]);
    const id = stringField(objectPayload(event), "id");
    const work = projected.workItems.get(id);
    if (!work) throw new Error(`Unable to project WorkItem ${id}`);
    this.upsertWork(work, event.createdAt);
  }

  private updateWork(event: MissionEvent, status?: WorkStatus, patch?: unknown): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const current = this.readJson<WorkItem>("rm_work_items", event.missionId, id);
    if (!current) throw new Error(`Read-model WorkItem not found: ${event.missionId}/${id}`);
    const patchObject = patch && typeof patch === "object" && !Array.isArray(patch) ? patch as Partial<WorkItem> : {};
    const next: WorkItem = {
      ...current,
      ...patchObject,
      ...(status ? { status } : {}),
      updatedAt: event.createdAt
    };
    this.upsertWork(next, event.createdAt);
  }

  private upsertWork(work: WorkItem, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO rm_work_items (mission_id, id, status, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(work.missionId, work.id, work.status, JSON.stringify(work), updatedAt);
  }

  private createAttempt(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const data = { ...payload, missionId: event.missionId, status: payload.status ?? "created", createdAt: event.createdAt };
    this.upsertLifecycle("rm_attempts", event.missionId, id, stringField(payload, "workItemId"), undefined, String(data.status), data, event.createdAt);
  }

  private updateAttempt(event: MissionEvent, status: string): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const current = this.readJson<Record<string, unknown>>("rm_attempts", event.missionId, id);
    if (!current) throw new Error(`Read-model Attempt not found: ${event.missionId}/${id}`);
    const data = { ...current, ...payload, status, endedAt: event.createdAt };
    this.upsertLifecycle("rm_attempts", event.missionId, id, stringField(data, "workItemId"), undefined, status, data, event.createdAt);
  }

  private createExecution(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const data = { ...payload, missionId: event.missionId, status: "created", createdAt: event.createdAt };
    this.upsertLifecycle(
      "rm_executions", event.missionId, id, stringField(payload, "workItemId"), stringField(payload, "attemptId"), "created", data, event.createdAt
    );
  }

  private updateExecution(event: MissionEvent, status: string): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const current = this.readJson<Record<string, unknown>>("rm_executions", event.missionId, id);
    if (!current) throw new Error(`Read-model Execution not found: ${event.missionId}/${id}`);
    const data = {
      ...current,
      ...payload,
      status,
      ...(status === "running" && !current.startedAt ? { startedAt: event.createdAt } : {}),
      ...(["completed", "failed", "lost", "cancelled"].includes(status) ? { endedAt: event.createdAt } : {})
    };
    this.upsertLifecycle(
      "rm_executions", event.missionId, id, stringField(data, "workItemId"), stringField(data, "attemptId"), status, data, event.createdAt
    );
  }

  private upsertLifecycle(
    table: "rm_attempts" | "rm_executions",
    missionId: string,
    id: string,
    workItemId: string,
    attemptId: string | undefined,
    status: string,
    data: unknown,
    updatedAt: string
  ): void {
    if (table === "rm_attempts") {
      this.db.prepare(`
        INSERT INTO rm_attempts (mission_id, id, work_item_id, status, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(mission_id, id) DO UPDATE SET
          work_item_id = excluded.work_item_id,
          status = excluded.status,
          data_json = excluded.data_json,
          updated_at = excluded.updated_at
      `).run(missionId, id, workItemId, status, JSON.stringify(data), updatedAt);
      return;
    }
    if (!attemptId) throw new Error(`Execution ${missionId}/${id} is missing attemptId`);
    this.db.prepare(`
      INSERT INTO rm_executions (mission_id, id, work_item_id, attempt_id, status, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        work_item_id = excluded.work_item_id,
        attempt_id = excluded.attempt_id,
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(missionId, id, workItemId, attemptId, status, JSON.stringify(data), updatedAt);
  }

  private createArtifact(event: MissionEvent): void {
    const projected = projectMissionJournal(event.missionId, [event]);
    const artifact = [...projected.artifacts.values()][0];
    if (!artifact) throw new Error(`Unable to project Artifact from event ${event.id}`);
    this.upsertArtifact(artifact, event.createdAt);
  }

  private updateArtifactStatus(event: MissionEvent, ref: string, status: ArtifactStatus): void {
    const parsed = parseArtifactRef(ref);
    const current = this.readArtifact(event.missionId, parsed.id, parsed.version);
    if (!current) return;
    this.upsertArtifact({ ...current, status }, event.createdAt);
  }

  private upsertArtifact(artifact: Artifact, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO rm_artifacts (mission_id, id, version, logical_name, status, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id, version) DO UPDATE SET
        logical_name = excluded.logical_name,
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(
      artifact.missionId, artifact.id, artifact.version, artifact.logicalName,
      artifact.status, JSON.stringify(artifact), updatedAt
    );
  }

  private createFinding(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    this.db.prepare(`
      INSERT OR REPLACE INTO rm_findings (mission_id, id, data_json, created_at)
      VALUES (?, ?, ?, ?)
    `).run(event.missionId, id, JSON.stringify(payload), event.createdAt);
  }

  private createGap(event: MissionEvent): void {
    const projected = projectMissionJournal(event.missionId, [event]);
    const id = stringField(objectPayload(event), "id");
    const gap = projected.gaps.get(id);
    if (!gap) throw new Error(`Unable to project Gap ${id}`);
    this.upsertGap(gap, event.createdAt);
  }

  private updateGap(event: MissionEvent, status: "resolved" | "accepted"): void {
    const id = stringField(objectPayload(event), "id");
    const current = this.readJson<Gap>("rm_gaps", event.missionId, id);
    if (!current) throw new Error(`Read-model Gap not found: ${event.missionId}/${id}`);
    this.upsertGap({ ...current, status, resolvedAt: event.createdAt }, event.createdAt);
  }

  private upsertGap(gap: Gap, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO rm_gaps (mission_id, id, status, severity, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        status = excluded.status,
        severity = excluded.severity,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(gap.missionId, gap.id, gap.status, gap.severity, JSON.stringify(gap), updatedAt);
  }

  private createDecision(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const data = { ...payload, missionId: event.missionId, status: payload.status ?? "proposed" };
    this.upsertDecision(event.missionId, id, String(data.status), data, event.createdAt);
  }

  private updateDecision(event: MissionEvent, status: string): void {
    const id = stringField(objectPayload(event), "id");
    const current = this.readJson<Record<string, unknown>>("rm_decisions", event.missionId, id);
    if (!current) throw new Error(`Read-model Decision not found: ${event.missionId}/${id}`);
    this.upsertDecision(event.missionId, id, status, { ...current, status, appliedAt: event.createdAt }, event.createdAt);
  }

  private upsertDecision(missionId: string, id: string, status: string, data: unknown, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO rm_decisions (mission_id, id, status, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(missionId, id, status, JSON.stringify(data), updatedAt);
  }

  private createApproval(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const data = { ...payload, missionId: event.missionId, status: payload.status ?? "pending" };
    this.upsertApproval(event.missionId, id, String(data.status), data, event.createdAt);
  }

  private updateApproval(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const current = this.readJson<Record<string, unknown>>("rm_approvals", event.missionId, id);
    if (!current) throw new Error(`Read-model Approval not found: ${event.missionId}/${id}`);
    const status = typeof payload.status === "string" ? payload.status : payload.approved ? "approved" : "rejected";
    this.upsertApproval(event.missionId, id, status, { ...current, ...payload, status }, event.createdAt);
  }

  private upsertApproval(missionId: string, id: string, status: string, data: unknown, updatedAt: string): void {
    this.db.prepare(`
      INSERT INTO rm_approvals (mission_id, id, status, data_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        status = excluded.status,
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(missionId, id, status, JSON.stringify(data), updatedAt);
  }

  private createCapabilityNeed(event: MissionEvent): void {
    const projected = projectMissionJournal(event.missionId, [event]);
    const id = stringField(objectPayload(event), "id");
    const need = projected.capabilityNeeds.get(id);
    if (!need) throw new Error(`Unable to project CapabilityNeed ${id}`);
    this.upsertSimple("rm_capability_needs", need.missionId, need.id, need, event.createdAt);
  }

  private createCapability(event: MissionEvent): void {
    const projected = projectMissionJournal(event.missionId, [event]);
    const capability = [...projected.capabilities.values()][0];
    if (!capability) throw new Error(`Unable to project Capability from event ${event.id}`);
    this.upsertSimple("rm_capabilities", event.missionId, capability.id, capability, event.createdAt);
  }

  private removeCapability(event: MissionEvent): void {
    const capabilityId = stringField(objectPayload(event), "capabilityId");
    this.db.prepare("DELETE FROM rm_capabilities WHERE mission_id = ? AND id = ?")
      .run(event.missionId, capabilityId);
  }

  private createCapabilityTrust(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const capabilityId = stringField(payload, "capabilityId");
    const recordedAt = typeof payload.recordedAt === "string" && payload.recordedAt ? payload.recordedAt : event.createdAt;
    this.db.prepare(`
      INSERT OR REPLACE INTO rm_capability_trust (mission_id, id, capability_id, data_json, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(event.missionId, id, capabilityId, JSON.stringify(payload), recordedAt);
  }

  private createCapabilityCost(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const capabilityId = stringField(payload, "capabilityId");
    const phase = stringField(payload, "phase");
    const recordedAt = typeof payload.recordedAt === "string" && payload.recordedAt ? payload.recordedAt : event.createdAt;
    this.db.prepare(`
      INSERT OR REPLACE INTO rm_capability_cost (mission_id, id, capability_id, phase, data_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.missionId, id, capabilityId, phase, JSON.stringify(payload), recordedAt);
  }

  private createCapabilityAudit(event: MissionEvent): void {
    const payload = objectPayload(event);
    const id = stringField(payload, "id");
    const decision = stringField(payload, "decision");
    const capabilityId = typeof payload.capabilityId === "string" && payload.capabilityId ? payload.capabilityId : null;
    const recordedAt = typeof payload.recordedAt === "string" && payload.recordedAt ? payload.recordedAt : event.createdAt;
    this.db.prepare(`
      INSERT OR REPLACE INTO rm_capability_audit (mission_id, id, capability_id, decision, data_json, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.missionId, id, capabilityId, decision, JSON.stringify(payload), recordedAt);
  }

  private upsertSimple(
    table: "rm_capability_needs" | "rm_capabilities",
    missionId: string,
    id: string,
    data: CapabilityNeed | CapabilityDescriptor,
    updatedAt: string
  ): void {
    this.db.prepare(`
      INSERT INTO ${table} (mission_id, id, data_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        data_json = excluded.data_json,
        updated_at = excluded.updated_at
    `).run(missionId, id, JSON.stringify(data), updatedAt);
  }

  private readJson<T>(
    table: "rm_work_items" | "rm_attempts" | "rm_executions" | "rm_gaps" | "rm_decisions" | "rm_approvals",
    missionId: string,
    id: string
  ): T | undefined {
    const row = this.db.prepare(`SELECT data_json FROM ${table} WHERE mission_id = ? AND id = ?`)
      .get(missionId, id) as { data_json?: string } | undefined;
    return row?.data_json ? JSON.parse(row.data_json) as T : undefined;
  }

  private readArtifact(missionId: string, id: string, version: number): Artifact | undefined {
    const row = this.db.prepare(
      "SELECT data_json FROM rm_artifacts WHERE mission_id = ? AND id = ? AND version = ?"
    ).get(missionId, id, version) as { data_json?: string } | undefined;
    return row?.data_json ? JSON.parse(row.data_json) as Artifact : undefined;
  }
}

function objectPayload(event: MissionEvent): Record<string, any> {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error(`Event ${event.type} requires an object payload for read-model projection`);
  }
  return event.payload as Record<string, any>;
}

function stringField(value: Record<string, any>, field: string): string {
  const result = value[field];
  if (typeof result !== "string" || result.length === 0) throw new Error(`Missing ${field} in read-model projection payload`);
  return result;
}

function numberField(value: Record<string, any>, field: string): number {
  const result = value[field];
  if (typeof result !== "number" || !Number.isFinite(result)) throw new Error(`Missing ${field} in read-model projection payload`);
  return result;
}

function parseArtifactRef(ref: string): { id: string; version: number } {
  const match = /^(.*)@(\d+)$/.exec(ref);
  if (!match || !match[1]) throw new Error(`Invalid artifact ref for read-model projection: ${ref}`);
  return { id: match[1], version: Number(match[2]) };
}
