import type { SourceRecord, TruthRecord } from "../../core/domain/knowledge.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { Evidence } from "../../core/domain/verification.ts";
import type { MissionDatabase } from "./database.ts";

export class SqliteKnowledgeProjector {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) { this.database = database; }

  apply(event: MissionEvent): void {
    const db = this.database.db;
    const payload = event.payload as any;
    switch (event.type) {
      case "source.registered": {
        const source = (payload.source ?? payload) as SourceRecord;
        if (!source?.id) return;
        db.prepare(`INSERT INTO sources (id, mission_id, status, uri, data_json, captured_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            uri = excluded.uri,
            data_json = excluded.data_json,
            captured_at = excluded.captured_at,
            updated_at = excluded.updated_at`)
          .run(source.id, event.missionId, source.status, source.uri ?? null, JSON.stringify(source), source.capturedAt, event.createdAt);
        return;
      }
      case "source.status.changed": {
        const row = db.prepare("SELECT data_json FROM sources WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const source = JSON.parse(row.data_json) as SourceRecord;
        source.status = payload.status;
        source.metadata = { ...(source.metadata ?? {}), lastStatusReason: payload.reason, lastStatusAt: event.createdAt };
        db.prepare("UPDATE sources SET status = ?, data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")
          .run(source.status, JSON.stringify(source), event.createdAt, source.id, event.missionId);
        return;
      }
      case "truth.added": {
        const truth = (payload.truth ?? payload) as TruthRecord;
        if (!truth?.id) return;
        db.prepare(`INSERT INTO truths (id, mission_id, truth_key, status, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            truth_key = excluded.truth_key,
            status = excluded.status,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at`)
          .run(truth.id, event.missionId, truth.key, truth.status, JSON.stringify(truth), truth.createdAt, event.createdAt);
        return;
      }
      case "truth.status.changed":
      case "truth.superseded": {
        const id = String(payload.id ?? payload.truthId ?? "");
        if (!id) return;
        const row = db.prepare("SELECT data_json FROM truths WHERE id = ? AND mission_id = ?").get(id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const truth = JSON.parse(row.data_json) as TruthRecord;
        truth.status = event.type === "truth.superseded" ? "superseded" : payload.status;
        if (payload.supersededBy) truth.supersededBy = payload.supersededBy;
        db.prepare("UPDATE truths SET status = ?, data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")
          .run(truth.status, JSON.stringify(truth), event.createdAt, truth.id, event.missionId);
        return;
      }
      case "evidence.invalidated": {
        const row = db.prepare("SELECT data_json FROM evidence WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const evidence = JSON.parse(row.data_json) as Evidence;
        evidence.validity = "invalid";
        db.prepare("UPDATE evidence SET data_json = ? WHERE id = ? AND mission_id = ?")
          .run(JSON.stringify(evidence), evidence.id, event.missionId);
        return;
      }
    }
  }
}
