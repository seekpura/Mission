import { randomUUID } from "node:crypto";
import type { EventStore } from "../core/events/event-store.ts";
import type {
  FileMissionHistoryArchiveStore,
  VerifiedMissionHistoryArchiveObject
} from "../persistence/archive/file-mission-history-archive-store.ts";
import type {
  MissionHistoryArchiveReceipt,
  MissionHistoryArchiveReceiptQuery
} from "../persistence/sqlite/mission-history-archive-receipt.ts";
import type { SqliteHistoryReader } from "../persistence/sqlite/sqlite-history-reader.ts";

const STORAGE_UNAVAILABLE_CODES = new Set([
  "EACCES",
  "EPERM",
  "ENOSPC",
  "EROFS",
  "EIO",
  "EMFILE",
  "ENFILE",
  "ENOTDIR",
  "ENOENT"
]);

export interface MissionHistoryArchiveCreatedPayload {
  objectId: string;
  storage: "filesystem";
  receipt: MissionHistoryArchiveReceipt;
}

export class MissionHistoryArchiveConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionHistoryArchiveConflictError";
  }
}

export class MissionHistoryArchiveUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionHistoryArchiveUnavailableError";
  }
}

export class MissionHistoryArchiveInternalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissionHistoryArchiveInternalError";
  }
}

export interface MissionHistoryArchiveOperator {
  create(
    missionId: string,
    query?: MissionHistoryArchiveReceiptQuery
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined>;
  verify(
    missionId: string,
    objectId: string
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined>;
}

/**
 * Explicit operator boundary for Mission history archives.
 *
 * Archive creation first produces and independently verifies the immutable
 * filesystem object, then records one durable Mission audit event keyed by the
 * content-addressed object id. If audit persistence fails the object may remain
 * on disk, but it is not considered durably registered; retry reuses the same
 * verified object and completes the idempotent audit append.
 *
 * Archive creation is a Runtime/operator control-plane write, not a model/Host
 * side effect. Verification is read-only. Neither action authorizes Event Store
 * deletion or compaction.
 */
export class RuntimeMissionHistoryArchiveOperator implements MissionHistoryArchiveOperator {
  private readonly history: Pick<SqliteHistoryReader, "readExportPage">;
  private readonly store: Pick<FileMissionHistoryArchiveStore, "archive" | "verify">;
  private readonly events: EventStore;

  constructor(
    history: Pick<SqliteHistoryReader, "readExportPage">,
    store: Pick<FileMissionHistoryArchiveStore, "archive" | "verify">,
    events: EventStore
  ) {
    this.history = history;
    this.store = store;
    this.events = events;
  }

  async create(
    missionId: string,
    query: MissionHistoryArchiveReceiptQuery = {}
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined> {
    let archived: VerifiedMissionHistoryArchiveObject | undefined;
    try {
      archived = await this.store.archive(this.history, missionId, query);
    } catch (error) {
      throw classifyArchiveStoreError(error);
    }
    if (!archived) return undefined;
    if (archived.receipt.missionId !== missionId) {
      throw new MissionHistoryArchiveConflictError(
        `Archive object ${archived.objectId} Mission mismatch: expected ${missionId}, received ${archived.receipt.missionId}`
      );
    }
    try {
      await this.register(missionId, archived);
    } catch (error) {
      if (error instanceof MissionHistoryArchiveInternalError) throw error;
      throw new MissionHistoryArchiveInternalError(
        `Mission history archive registration failed: ${errorMessage(error)}`
      );
    }
    return archived;
  }

  async verify(
    missionId: string,
    objectId: string
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined> {
    try {
      const verified = await this.store.verify(objectId);
      return verified.receipt.missionId === missionId ? verified : undefined;
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) return undefined;
      throw classifyArchiveStoreError(error);
    }
  }

  private async register(
    missionId: string,
    archived: VerifiedMissionHistoryArchiveObject
  ): Promise<void> {
    const idempotencyKey = `history-archive-created:${archived.objectId}`;
    const payload: MissionHistoryArchiveCreatedPayload = {
      objectId: archived.objectId,
      storage: "filesystem",
      receipt: archived.receipt
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = await this.events.lastSequence(missionId);
      try {
        await this.events.append({
          id: randomUUID(),
          missionId,
          type: "history.archive.created",
          actor: { type: "system", id: "mission-history-archive-operator" },
          payload,
          idempotencyKey,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        }, expected);
        return;
      } catch (error) {
        if (attempt === 3 || !(error instanceof Error) || !isConcurrencyConflict(error)) throw error;
      }
    }
  }
}

function classifyArchiveStoreError(error: unknown): Error {
  if (
    error instanceof MissionHistoryArchiveConflictError ||
    error instanceof MissionHistoryArchiveUnavailableError ||
    error instanceof MissionHistoryArchiveInternalError
  ) return error;
  if (isStorageUnavailable(error)) {
    return new MissionHistoryArchiveUnavailableError(
      `Mission history archive storage is unavailable: ${errorMessage(error)}`
    );
  }
  if (error instanceof Error && error.message.toLowerCase().includes("archive")) {
    return new MissionHistoryArchiveConflictError(
      `Mission history archive object conflict: ${error.message}`
    );
  }
  return new MissionHistoryArchiveInternalError(
    `Mission history archive operation failed: ${errorMessage(error)}`
  );
}

function isStorageUnavailable(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  return typeof code === "string" && STORAGE_UNAVAILABLE_CODES.has(code);
}

function isConcurrencyConflict(error: Error): boolean {
  return error.name.includes("Concurrency") || error.message.includes("expected sequence");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
