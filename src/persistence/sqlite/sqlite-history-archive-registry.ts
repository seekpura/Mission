import type { DatabaseSync } from "node:sqlite";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { MissionHistoryArchiveReceipt } from "./mission-history-archive-receipt.ts";
import type { MissionDatabase } from "./database.ts";
import { rowToMissionEvent, type SqliteMissionEventRow } from "./sqlite-event-row.ts";

const PROJECTION_NAME = "mission-history-archive-registry-v1";
const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_REGISTRATION_JSON_BYTES = 32 * 1024;
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 500;

export interface MissionHistoryArchiveRegistration {
  objectId: string;
  storage: "filesystem";
  receipt: MissionHistoryArchiveReceipt;
  eventSequence: number;
  registeredAt: string;
}

export interface MissionHistoryArchiveRegistryQuery {
  afterSequence?: number;
  limit?: number;
}

export interface MissionHistoryArchiveRegistryPage {
  items: MissionHistoryArchiveRegistration[];
  nextAfterSequence?: number;
}

/**
 * Durable projection and bounded reader for operator-created Mission archives.
 *
 * The Event Store invokes apply/catch-up inside the same SQLite transaction as
 * mission_events. Public pagination deliberately uses the durable Mission event
 * sequence rather than a projection-local rowid so cursors survive read-model
 * rebuilds. The registry records archive integrity metadata only; it never
 * authorizes Event Store deletion or substitutes archive data into recovery.
 */
export class SqliteHistoryArchiveRegistry {
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

  /** Caller already owns the SQLite write transaction when invoked from append. */
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
        `History archive registry projection sequence gap for ${event.missionId}: checkpoint=${checkpoint}, event=${event.sequence}`
      );
    }

    if (event.type === "history.archive.created") this.upsertRegistration(event);
    this.db.prepare(`
      INSERT INTO rm_projection_checkpoints (projection_name, mission_id, event_sequence, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(projection_name, mission_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        updated_at = excluded.updated_at
    `).run(PROJECTION_NAME, event.missionId, event.sequence, event.createdAt);
  }

  readHistoryArchives(
    missionId: string,
    query: MissionHistoryArchiveRegistryQuery = {}
  ): MissionHistoryArchiveRegistryPage | undefined {
    const mission = this.db.prepare("SELECT 1 FROM rm_missions WHERE mission_id = ?").get(missionId);
    if (!mission) return undefined;

    const afterSequence = boundedNonNegativeInteger(query.afterSequence ?? 0, "afterSequence");
    const limit = boundedLimit(query.limit);
    const rows = this.db.prepare(`
      SELECT event_sequence, data_json
      FROM rm_history_archives
      WHERE mission_id = ? AND event_sequence > ?
      ORDER BY event_sequence ASC
      LIMIT ?
    `).all(missionId, afterSequence, limit + 1) as Array<{ event_sequence: number; data_json: string }>;

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(row => {
      const parsed = JSON.parse(row.data_json) as MissionHistoryArchiveRegistration;
      if (parsed.eventSequence !== row.event_sequence) {
        throw new Error(
          `History archive registry sequence mismatch for ${missionId}/${parsed.objectId}: row=${row.event_sequence}, data=${parsed.eventSequence}`
        );
      }
      return parsed;
    });
    return {
      items,
      ...(hasMore && items.length > 0 ? { nextAfterSequence: items[items.length - 1].eventSequence } : {})
    };
  }

  private checkpoint(missionId: string): number {
    const row = this.db.prepare(
      "SELECT event_sequence FROM rm_projection_checkpoints WHERE projection_name = ? AND mission_id = ?"
    ).get(PROJECTION_NAME, missionId) as { event_sequence?: number } | undefined;
    return row?.event_sequence ?? 0;
  }

  private upsertRegistration(event: MissionEvent): void {
    const registration = registrationFromEvent(event);
    const existing = this.db.prepare(
      "SELECT event_sequence FROM rm_history_archives WHERE mission_id = ? AND object_id = ?"
    ).get(event.missionId, registration.objectId) as { event_sequence: number } | undefined;
    if (existing && existing.event_sequence !== event.sequence) {
      throw new Error(
        `History archive object ${registration.objectId} was registered at conflicting sequences ${existing.event_sequence} and ${event.sequence}`
      );
    }

    const serialized = JSON.stringify(registration);
    if (Buffer.byteLength(serialized, "utf8") > MAX_REGISTRATION_JSON_BYTES) {
      throw new Error(`History archive registration exceeds ${MAX_REGISTRATION_JSON_BYTES} bytes`);
    }
    this.db.prepare(`
      INSERT INTO rm_history_archives
        (mission_id, object_id, event_sequence, data_json, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(mission_id, object_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        data_json = excluded.data_json,
        created_at = excluded.created_at
    `).run(
      event.missionId,
      registration.objectId,
      event.sequence,
      serialized,
      event.createdAt
    );
  }
}

function registrationFromEvent(event: MissionEvent): MissionHistoryArchiveRegistration {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("history.archive.created requires an object payload");
  }
  const payload = event.payload as Record<string, unknown>;
  const objectId = requiredString(payload.objectId, "history.archive.created.objectId");
  if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error("history.archive.created objectId must be a lowercase SHA-256");
  if (payload.storage !== "filesystem") throw new Error("history.archive.created storage must be filesystem");
  if (!payload.receipt || typeof payload.receipt !== "object" || Array.isArray(payload.receipt)) {
    throw new Error("history.archive.created requires a receipt object");
  }
  const receipt = structuredClone(payload.receipt) as MissionHistoryArchiveReceipt;
  if (receipt.missionId !== event.missionId) {
    throw new Error(`History archive receipt Mission mismatch: ${String(receipt.missionId)} != ${event.missionId}`);
  }
  if (receipt.receiptSha256 !== objectId) {
    throw new Error(`History archive receipt identity mismatch: ${String(receipt.receiptSha256)} != ${objectId}`);
  }
  if (receipt.authorizesDeletion !== false) {
    throw new Error("History archive registry refuses receipts that authorize deletion");
  }
  return {
    objectId,
    storage: "filesystem",
    receipt,
    eventSequence: event.sequence,
    registeredAt: event.createdAt
  };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Expected non-empty string at ${path}`);
  return value.trim();
}

function boundedNonNegativeInteger(value: number, path: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${path} must be a non-negative safe integer`);
  return value;
}

function boundedLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return limit;
}
