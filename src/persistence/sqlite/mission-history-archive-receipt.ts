import { createHash } from "node:crypto";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { SqliteHistoryReader } from "./sqlite-history-reader.ts";

const RECEIPT_EXPORT_PAGE_SIZE = 5000;

export interface MissionHistoryArchiveReceiptQuery {
  throughSequence?: number;
}

export interface MissionHistoryArchiveReceiptCore {
  format: "mission-history-archive-receipt/v1";
  eventFormat: "mission-events/v1";
  canonicalization: "canonical-json-v1+lf";
  hashAlgorithm: "sha256";
  missionId: string;
  fromSequence: 0 | 1;
  throughSequence: number;
  eventCount: number;
  contentBytes: number;
  contentSha256: string;
  authorizesDeletion: false;
}

export interface MissionHistoryArchiveReceipt extends MissionHistoryArchiveReceiptCore {
  receiptSha256: string;
}

/**
 * Deterministic integrity receipt for a fixed Mission Event prefix.
 *
 * Content digest bytes are the UTF-8 encoding of one canonical JSON event per
 * line, including a trailing LF after every event. Object keys are sorted
 * lexicographically at every nesting level; arrays retain their original order.
 *
 * The receipt is integrity-only. It never authorizes Event Store deletion.
 */
export class MissionHistoryArchiveReceiptReader {
  private readonly history: Pick<SqliteHistoryReader, "readExportPage">;

  constructor(history: Pick<SqliteHistoryReader, "readExportPage">) {
    this.history = history;
  }

  readReceipt(
    missionId: string,
    query: MissionHistoryArchiveReceiptQuery = {}
  ): MissionHistoryArchiveReceipt | undefined {
    let page = this.history.readExportPage(missionId, {
      ...(query.throughSequence !== undefined ? { throughSequence: query.throughSequence } : {}),
      limit: RECEIPT_EXPORT_PAGE_SIZE
    });
    if (!page) return undefined;

    const throughSequence = page.throughSequence;
    const contentHash = createHash("sha256");
    let eventCount = 0;
    let contentBytes = 0;

    while (true) {
      for (const event of page.events) {
        const line = canonicalMissionEventLine(event);
        contentHash.update(line, "utf8");
        eventCount += 1;
        contentBytes += Buffer.byteLength(line, "utf8");
      }
      if (page.complete) break;
      if (page.nextAfterSequence === undefined) {
        throw new Error(`Mission archive receipt export did not provide a continuation cursor for ${missionId}`);
      }
      page = this.history.readExportPage(missionId, {
        afterSequence: page.nextAfterSequence,
        throughSequence,
        limit: RECEIPT_EXPORT_PAGE_SIZE
      });
      if (!page) {
        throw new Error(`Mission archive receipt source disappeared while reading ${missionId}`);
      }
      if (page.throughSequence !== throughSequence) {
        throw new Error(
          `Mission archive receipt export boundary changed for ${missionId}: expected ${throughSequence}, received ${page.throughSequence}`
        );
      }
    }

    if (eventCount !== throughSequence) {
      throw new Error(
        `Mission archive receipt event count mismatch for ${missionId}: expected ${throughSequence}, received ${eventCount}`
      );
    }

    const core: MissionHistoryArchiveReceiptCore = {
      format: "mission-history-archive-receipt/v1",
      eventFormat: "mission-events/v1",
      canonicalization: "canonical-json-v1+lf",
      hashAlgorithm: "sha256",
      missionId,
      fromSequence: throughSequence === 0 ? 0 : 1,
      throughSequence,
      eventCount,
      contentBytes,
      contentSha256: contentHash.digest("hex"),
      authorizesDeletion: false
    };

    return {
      ...core,
      receiptSha256: sha256Hex(canonicalJsonV1(core))
    };
  }
}

export function canonicalMissionEventLine(event: MissionEvent): string {
  return `${canonicalJsonV1(event)}\n`;
}

/**
 * Canonical JSON v1 used by archive receipts.
 *
 * - object keys sorted lexicographically
 * - array order preserved
 * - UTF-8 JSON scalar encoding from JSON.stringify
 * - undefined object properties omitted, matching JSON object semantics
 * - unsupported/non-finite values rejected to avoid ambiguous receipts
 */
export function canonicalJsonV1(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical-json-v1 rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => {
      if (item === undefined) throw new Error("canonical-json-v1 rejects undefined array entries");
      return canonicalJsonV1(item);
    }).join(",")}]`;
  }
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    const entries: string[] = [];
    for (const key of Object.keys(object).sort()) {
      const item = object[key];
      if (item === undefined) continue;
      entries.push(`${JSON.stringify(key)}:${canonicalJsonV1(item)}`);
    }
    return `{${entries.join(",")}}`;
  }
  throw new Error(`canonical-json-v1 rejects unsupported value type: ${typeof value}`);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
