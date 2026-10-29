import type { FileMissionHistoryArchiveStore, VerifiedMissionHistoryArchiveObject } from "../persistence/archive/file-mission-history-archive-store.ts";
import type { MissionHistoryArchiveReceiptQuery } from "../persistence/sqlite/mission-history-archive-receipt.ts";
import type { SqliteHistoryReader } from "../persistence/sqlite/sqlite-history-reader.ts";

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
 * Archive creation is an operator-requested write into Runtime-owned archive
 * storage. It is not a provider/Host side effect and does not run through the
 * model permission bridge. Verification is read-only. Neither action changes
 * Event Store retention or deletion eligibility.
 */
export class RuntimeMissionHistoryArchiveOperator implements MissionHistoryArchiveOperator {
  private readonly history: Pick<SqliteHistoryReader, "readExportPage">;
  private readonly store: Pick<FileMissionHistoryArchiveStore, "archive" | "verify">;

  constructor(
    history: Pick<SqliteHistoryReader, "readExportPage">,
    store: Pick<FileMissionHistoryArchiveStore, "archive" | "verify">
  ) {
    this.history = history;
    this.store = store;
  }

  create(
    missionId: string,
    query: MissionHistoryArchiveReceiptQuery = {}
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined> {
    return this.store.archive(this.history, missionId, query);
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
      throw error;
    }
  }
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}
