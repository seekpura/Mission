import type { DatabaseSync } from "node:sqlite";
import type { Evidence, VerificationEvidenceKind } from "../../core/domain/verification.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

const PROJECTION_NAME = "verification-evidence-read-model-v1";

const EVIDENCE_TYPES = new Set<Evidence["type"]>([
  "test-result",
  "render-inspection",
  "source",
  "runtime-check",
  "human-approval",
  "automated-review",
  "file-validation"
]);
const EVIDENCE_RESULTS = new Set<Evidence["result"]>(["supports", "contradicts", "inconclusive"]);
const EVIDENCE_KINDS = new Set<VerificationEvidenceKind>([
  "file-integrity",
  "text-content",
  "presentation-package",
  "presentation-render",
  "website-source",
  "browser-runtime",
  "accessibility-check",
  "media-probe",
  "media-playback",
  "code-source",
  "executable-test",
  "build-check",
  "integration-test",
  "static-analysis",
  "source-traceability",
  "source-recency"
]);

/**
 * Independent projection for durable Runtime-collected verification evidence.
 * The Event Store invokes this projector inside the same SQLite write
 * transaction as mission_events and the primary Mission read-model projector.
 */
export class SqliteEvidenceProjector {
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
        `Evidence projection sequence gap for ${event.missionId}: checkpoint=${checkpoint}, event=${event.sequence}`
      );
    }

    if (event.type === "evidence.collected") this.insertEvidence(event);
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

  private insertEvidence(event: MissionEvent): void {
    const evidence = validateEvidence(event);
    this.db.prepare(`
      INSERT INTO rm_evidence
        (mission_id, id, subject_ref, evidence_kind, collector_id, result, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, id) DO UPDATE SET
        subject_ref = excluded.subject_ref,
        evidence_kind = excluded.evidence_kind,
        collector_id = excluded.collector_id,
        result = excluded.result,
        data_json = excluded.data_json,
        created_at = excluded.created_at
    `).run(
      evidence.missionId,
      evidence.id,
      evidence.subjectRef,
      evidence.kind,
      evidence.collectorId,
      evidence.result,
      JSON.stringify(evidence),
      evidence.createdAt
    );
  }
}

function validateEvidence(event: MissionEvent): Evidence {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("evidence.collected requires an Evidence object payload");
  }
  const value = event.payload as Record<string, unknown>;
  const id = requiredString(value.id, "evidence.id");
  const missionId = requiredString(value.missionId, "evidence.missionId");
  if (missionId !== event.missionId) throw new Error(`Evidence mission mismatch: ${missionId} != ${event.missionId}`);
  const subjectRef = requiredString(value.subjectRef, "evidence.subjectRef");
  const type = requiredString(value.type, "evidence.type") as Evidence["type"];
  if (!EVIDENCE_TYPES.has(type)) throw new Error(`Unsupported Evidence type: ${type}`);
  const kind = requiredString(value.kind, "evidence.kind") as VerificationEvidenceKind;
  if (!EVIDENCE_KINDS.has(kind)) throw new Error(`Unsupported verification evidence kind: ${kind}`);
  const claim = requiredString(value.claim, "evidence.claim");
  const result = requiredString(value.result, "evidence.result") as Evidence["result"];
  if (!EVIDENCE_RESULTS.has(result)) throw new Error(`Unsupported Evidence result: ${result}`);
  const collectorId = requiredString(value.collectorId, "evidence.collectorId");
  const createdAt = requiredString(value.createdAt, "evidence.createdAt");
  if (value.details !== undefined && (!value.details || typeof value.details !== "object" || Array.isArray(value.details))) {
    throw new Error("Evidence details must be an object when supplied");
  }
  return {
    id,
    missionId,
    subjectRef,
    type,
    kind,
    claim,
    result,
    collectorId,
    ...(typeof value.sourceRef === "string" && value.sourceRef ? { sourceRef: value.sourceRef } : {}),
    ...(typeof value.producedBy === "string" && value.producedBy ? { producedBy: value.producedBy } : {}),
    ...(value.details ? { details: structuredClone(value.details as Record<string, unknown>) } : {}),
    createdAt
  };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string at ${path}`);
  return value.trim();
}
