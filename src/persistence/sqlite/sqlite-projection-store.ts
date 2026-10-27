import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionState } from "../../core/domain/mission.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { Gap } from "../../core/domain/verification.ts";
import { applyMissionEvent, initialMissionState } from "../../core/events/state-projector.ts";
import type { MissionProjectionReader, MissionProjectionWriter } from "../../core/events/projection-store.ts";
import type { MissionDatabase } from "./database.ts";

export class SqliteProjectionStore implements MissionProjectionReader, MissionProjectionWriter {
  private readonly database: MissionDatabase;
  constructor(database: MissionDatabase) { this.database = database; }

  apply(event: MissionEvent): void {
    const db = this.database.db;
    const row = db.prepare("SELECT state_json FROM mission_states WHERE mission_id = ?").get(event.missionId) as { state_json: string } | undefined;
    const current = row ? JSON.parse(row.state_json) as MissionState : initialMissionState(event.missionId);
    const next = applyMissionEvent(current, event);

    db.prepare(`INSERT INTO mission_states (mission_id, event_sequence, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at`)
      .run(event.missionId, event.sequence, JSON.stringify(next), event.createdAt);

    db.prepare(`INSERT INTO missions (id, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        revision = excluded.revision,
        updated_at = excluded.updated_at`)
      .run(event.missionId, next.status, next.revision, next.createdAt ?? event.createdAt, event.createdAt);

    this.applyEntityProjection(event);
  }

  rebuild(missionId: string, events: MissionEvent[]): void {
    const db = this.database.db;
    db.prepare("DELETE FROM mission_states WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM missions WHERE id = ?").run(missionId);
    db.prepare("DELETE FROM work_items WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM gaps WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM decisions WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM approvals WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM capabilities WHERE mission_id = ?").run(missionId);
    for (const event of events) this.apply(event);
  }

  async getMissionState(missionId: string): Promise<MissionState | null> {
    const row = this.database.db.prepare("SELECT state_json FROM mission_states WHERE mission_id = ?")
      .get(missionId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as MissionState : null;
  }

  async listWorkItems(missionId: string): Promise<WorkItem[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM work_items WHERE mission_id = ? ORDER BY priority DESC, created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as WorkItem);
  }

  async listGaps(missionId: string): Promise<Gap[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM gaps WHERE mission_id = ? ORDER BY opened_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Gap);
  }

  private applyEntityProjection(event: MissionEvent): void {
    const db = this.database.db;
    const payload = event.payload as any;
    switch (event.type) {
      case "work.created": {
        const work = (payload.work ?? payload) as WorkItem;
        if (!work?.id) return;
        db.prepare(`INSERT INTO work_items
          (id, mission_id, status, purpose, priority, graph_revision, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            purpose = excluded.purpose,
            priority = excluded.priority,
            graph_revision = excluded.graph_revision,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at`)
          .run(work.id, work.missionId, work.status, work.purpose, work.priority, work.graphRevision, JSON.stringify(work), work.createdAt, work.updatedAt);
        return;
      }
      case "work.started":
        this.updateWork(payload.id, "running", event.createdAt);
        return;
      case "work.updated":
        this.updateWork(payload.id, payload.status, event.createdAt);
        return;
      case "work.completed":
        this.updateWork(payload.id, "succeeded", event.createdAt);
        return;
      case "work.failed":
        this.updateWork(payload.id, "failed", event.createdAt);
        return;
      case "work.blocked":
        this.updateWork(payload.id, "blocked", event.createdAt);
        return;
      case "work.invalidated":
        this.updateWork(payload.id, "invalidated", event.createdAt);
        return;
      case "gap.opened": {
        const gap: Gap = {
          id: payload.id,
          missionId: event.missionId,
          category: payload.category ?? "quality",
          severity: payload.severity,
          description: payload.description ?? "Unspecified mission gap",
          findingRefs: payload.findingRefs ?? [],
          requirementRefs: payload.requirementRefs ?? [],
          artifactRefs: payload.artifactRefs ?? [],
          status: "open",
          openedAt: payload.openedAt ?? event.createdAt
        };
        db.prepare(`INSERT INTO gaps
          (id, mission_id, category, severity, status, description, data_json, opened_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            category = excluded.category,
            severity = excluded.severity,
            status = excluded.status,
            description = excluded.description,
            data_json = excluded.data_json`)
          .run(gap.id, gap.missionId, gap.category, gap.severity, gap.status, gap.description, JSON.stringify(gap), gap.openedAt);
        return;
      }
      case "gap.resolved":
      case "gap.accepted": {
        const row = db.prepare("SELECT data_json FROM gaps WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const gap = JSON.parse(row.data_json) as Gap;
        gap.status = event.type === "gap.resolved" ? "resolved" : "accepted";
        gap.resolvedAt = event.createdAt;
        db.prepare("UPDATE gaps SET status = ?, data_json = ?, resolved_at = ? WHERE id = ? AND mission_id = ?")
          .run(gap.status, JSON.stringify(gap), event.createdAt, gap.id, event.missionId);
        return;
      }
      case "decision.created": {
        const decision = payload.decision ?? payload;
        if (!decision?.id) return;
        db.prepare(`INSERT INTO decisions (id, mission_id, type, status, rationale, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, rationale = excluded.rationale, data_json = excluded.data_json`)
          .run(decision.id, event.missionId, decision.type, decision.status ?? "proposed", decision.rationale ?? "", JSON.stringify(decision), decision.createdAt ?? event.createdAt);
        return;
      }
      case "decision.applied":
        if (payload.id) db.prepare("UPDATE decisions SET status = 'applied' WHERE id = ? AND mission_id = ?").run(payload.id, event.missionId);
        return;
      case "approval.requested": {
        if (!payload.id) return;
        db.prepare(`INSERT INTO approvals (id, mission_id, status, scope, request_json, result_json, requested_at, decided_at)
          VALUES (?, ?, 'pending', ?, ?, NULL, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET status = 'pending', request_json = excluded.request_json`)
          .run(payload.id, event.missionId, payload.scope ?? "once", JSON.stringify(payload), event.createdAt);
        return;
      }
      case "approval.decided":
        if (payload.id) db.prepare("UPDATE approvals SET status = ?, result_json = ?, decided_at = ? WHERE id = ? AND mission_id = ?")
          .run(payload.approved ? "approved" : "rejected", JSON.stringify(payload), event.createdAt, payload.id, event.missionId);
        return;
      case "capability.activated": {
        const capability = payload.capability ?? payload;
        if (!capability?.id) return;
        db.prepare(`INSERT INTO capabilities (id, mission_id, scope, kind, status, source_uri, revision, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json`)
          .run(capability.id, event.missionId, capability.scope ?? "mission", capability.kind ?? "tool", capability.status ?? "available", capability.sourceUri ?? null, capability.revision ?? null, JSON.stringify(capability), event.createdAt);
        return;
      }
    }
  }

  private updateWork(id: string | undefined, status: WorkItem["status"], updatedAt: string): void {
    if (!id) return;
    const row = this.database.db.prepare("SELECT data_json FROM work_items WHERE id = ?").get(id) as { data_json: string } | undefined;
    if (!row) return;
    const work = JSON.parse(row.data_json) as WorkItem;
    work.status = status;
    work.updatedAt = updatedAt;
    this.database.db.prepare("UPDATE work_items SET status = ?, data_json = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(work), updatedAt, id);
  }
}
