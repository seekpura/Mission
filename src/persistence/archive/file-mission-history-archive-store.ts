import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { MissionEvent } from "../../core/domain/event.ts";
import {
  MissionHistoryArchiveReceiptReader,
  canonicalJsonV1,
  canonicalMissionEventLine,
  type MissionHistoryArchiveReceipt,
  type MissionHistoryArchiveReceiptCore,
  type MissionHistoryArchiveReceiptQuery
} from "../sqlite/mission-history-archive-receipt.ts";
import type { SqliteHistoryReader } from "../sqlite/sqlite-history-reader.ts";

const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;
const ARCHIVE_PAGE_SIZE = 5000;
const MAX_RECEIPT_BYTES = 16 * 1024;
const RECEIPT_FILENAME = "receipt.json";
const EVENTS_FILENAME = "events.jsonl";
const RECEIPT_KEYS = [
  "authorizesDeletion",
  "canonicalization",
  "contentBytes",
  "contentSha256",
  "eventCount",
  "eventFormat",
  "format",
  "fromSequence",
  "hashAlgorithm",
  "missionId",
  "receiptSha256",
  "throughSequence"
] as const;

export interface VerifiedMissionHistoryArchiveObject {
  objectId: string;
  receipt: MissionHistoryArchiveReceipt;
}

/**
 * Immutable content-addressed filesystem archive for verified Mission history.
 *
 * Object identity is the receipt SHA-256; Mission ids never participate in
 * filesystem paths. Archive creation writes into a private staging directory,
 * verifies the staged object from disk without SQLite, then atomically publishes
 * the verified directory. Existing objects are verified and reused, never
 * silently repaired or overwritten.
 *
 * Archive objects are integrity artifacts only. They do not authorize deletion
 * or compaction of the authoritative Mission Event Store.
 */
export class FileMissionHistoryArchiveStore {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    const normalized = rootDir.trim();
    if (!normalized) throw new Error("Mission history archive root must be non-empty");
    this.rootDir = resolve(normalized);
  }

  async archive(
    history: Pick<SqliteHistoryReader, "readExportPage">,
    missionId: string,
    query: MissionHistoryArchiveReceiptQuery = {}
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined> {
    const receipt = new MissionHistoryArchiveReceiptReader(history).readReceipt(missionId, query);
    if (!receipt) return undefined;
    validateReceipt(receipt, receipt.receiptSha256);

    await this.ensureStoreDirectories();
    const finalDir = this.objectDirectory(receipt.receiptSha256);
    if (await pathExists(finalDir)) {
      const existing = await this.verify(receipt.receiptSha256);
      assertSameReceipt(existing.receipt, receipt);
      return existing;
    }

    const stagingDir = join(this.rootDir, ".staging", randomUUID());
    await mkdir(stagingDir, { recursive: false, mode: 0o700 });
    try {
      await this.writeStagedObject(stagingDir, history, receipt);
      const staged = await verifyArchiveDirectory(stagingDir, receipt.receiptSha256);
      assertSameReceipt(staged.receipt, receipt);

      const finalParent = dirname(finalDir);
      await mkdir(finalParent, { recursive: true, mode: 0o700 });
      await assertDirectory(finalParent, "archive object prefix directory");
      try {
        await rename(stagingDir, finalDir);
      } catch (error) {
        if (!isExistingDestinationError(error)) throw error;
        await rm(stagingDir, { recursive: true, force: true });
        const existing = await this.verify(receipt.receiptSha256);
        assertSameReceipt(existing.receipt, receipt);
        return existing;
      }

      return await this.verify(receipt.receiptSha256);
    } catch (error) {
      await rm(stagingDir, { recursive: true, force: true });
      throw error;
    }
  }

  async verify(objectId: string): Promise<VerifiedMissionHistoryArchiveObject> {
    validateObjectId(objectId);
    await this.ensureStoreDirectories();
    const directory = this.objectDirectory(objectId);
    return verifyArchiveDirectory(directory, objectId);
  }

  private async writeStagedObject(
    stagingDir: string,
    history: Pick<SqliteHistoryReader, "readExportPage">,
    receipt: MissionHistoryArchiveReceipt
  ): Promise<void> {
    await assertDirectory(stagingDir, "archive staging directory");
    const eventsPath = join(stagingDir, EVENTS_FILENAME);
    const receiptPath = join(stagingDir, RECEIPT_FILENAME);
    const eventsFile = await open(eventsPath, "wx", 0o600);
    try {
      let afterSequence = 0;
      while (afterSequence < receipt.throughSequence) {
        const page = history.readExportPage(receipt.missionId, {
          afterSequence,
          throughSequence: receipt.throughSequence,
          limit: ARCHIVE_PAGE_SIZE
        });
        if (!page) throw new Error(`Mission archive source disappeared while writing ${receipt.missionId}`);
        if (page.throughSequence !== receipt.throughSequence) {
          throw new Error(
            `Mission archive source boundary changed for ${receipt.missionId}: expected ${receipt.throughSequence}, received ${page.throughSequence}`
          );
        }
        for (const event of page.events) await eventsFile.write(canonicalMissionEventLine(event), null, "utf8");
        if (page.complete) {
          afterSequence = receipt.throughSequence;
          break;
        }
        if (page.nextAfterSequence === undefined || page.nextAfterSequence <= afterSequence) {
          throw new Error(`Mission archive source did not advance for ${receipt.missionId}`);
        }
        afterSequence = page.nextAfterSequence;
      }
    } finally {
      await eventsFile.close();
    }

    const receiptFile = await open(receiptPath, "wx", 0o600);
    try {
      await receiptFile.write(`${canonicalJsonV1(receipt)}\n`, null, "utf8");
    } finally {
      await receiptFile.close();
    }
  }

  private objectDirectory(objectId: string): string {
    validateObjectId(objectId);
    return join(this.rootDir, "objects", objectId.slice(0, 2), objectId);
  }

  private async ensureStoreDirectories(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertDirectory(this.rootDir, "archive root");
    const objects = join(this.rootDir, "objects");
    const staging = join(this.rootDir, ".staging");
    await mkdir(objects, { recursive: true, mode: 0o700 });
    await mkdir(staging, { recursive: true, mode: 0o700 });
    await assertDirectory(objects, "archive objects directory");
    await assertDirectory(staging, "archive staging directory");
  }
}

async function verifyArchiveDirectory(
  directory: string,
  objectId: string
): Promise<VerifiedMissionHistoryArchiveObject> {
  validateObjectId(objectId);
  await assertDirectory(directory, "archive object directory");
  const receiptPath = join(directory, RECEIPT_FILENAME);
  const eventsPath = join(directory, EVENTS_FILENAME);
  const receiptStat = await assertRegularFile(receiptPath, "archive receipt");
  if (receiptStat.size > MAX_RECEIPT_BYTES) {
    throw new Error(`Archive receipt exceeds ${MAX_RECEIPT_BYTES} bytes`);
  }
  await assertRegularFile(eventsPath, "archive event data");

  const receiptBytes = await readFile(receiptPath);
  const receiptText = receiptBytes.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(receiptText);
  } catch (error) {
    throw new Error(`Archive receipt JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const receipt = validateReceipt(parsed, objectId);
  const expectedReceiptBytes = Buffer.from(`${canonicalJsonV1(receipt)}\n`, "utf8");
  if (!receiptBytes.equals(expectedReceiptBytes)) {
    throw new Error("Archive receipt file is not canonical-json-v1+lf");
  }

  const contentHash = createHash("sha256");
  let contentBytes = 0;
  let eventCount = 0;
  let expectedSequence = receipt.throughSequence === 0 ? 0 : 1;
  let pending = Buffer.alloc(0);

  for await (const rawChunk of createReadStream(eventsPath)) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    contentHash.update(chunk);
    contentBytes += chunk.length;
    if (contentBytes > receipt.contentBytes) {
      throw new Error("Archive event data exceeds receipt contentBytes");
    }
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    let newline = pending.indexOf(0x0a);
    while (newline !== -1) {
      const lineBytes = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (lineBytes.length === 0) throw new Error("Archive event data contains an empty line");
      const event = parseMissionEvent(lineBytes);
      if (event.missionId !== receipt.missionId) {
        throw new Error(`Archive event Mission mismatch: expected ${receipt.missionId}, received ${event.missionId}`);
      }
      if (event.sequence !== expectedSequence) {
        throw new Error(`Archive event sequence mismatch: expected ${expectedSequence}, received ${event.sequence}`);
      }
      const canonical = Buffer.from(canonicalMissionEventLine(event), "utf8");
      const original = Buffer.concat([lineBytes, Buffer.from("\n")]);
      if (!original.equals(canonical)) throw new Error(`Archive event ${event.sequence} is not canonical-json-v1+lf`);
      expectedSequence += 1;
      eventCount += 1;
      newline = pending.indexOf(0x0a);
    }
  }

  if (pending.length !== 0) throw new Error("Archive event data is missing its final LF");
  if (contentBytes !== receipt.contentBytes) {
    throw new Error(`Archive content byte count mismatch: expected ${receipt.contentBytes}, received ${contentBytes}`);
  }
  if (eventCount !== receipt.eventCount) {
    throw new Error(`Archive event count mismatch: expected ${receipt.eventCount}, received ${eventCount}`);
  }
  if (eventCount !== receipt.throughSequence) {
    throw new Error(`Archive prefix count mismatch: expected ${receipt.throughSequence}, received ${eventCount}`);
  }
  const contentSha256 = contentHash.digest("hex");
  if (contentSha256 !== receipt.contentSha256) {
    throw new Error(`Archive content SHA-256 mismatch: expected ${receipt.contentSha256}, received ${contentSha256}`);
  }

  return { objectId, receipt };
}

function validateReceipt(value: unknown, objectId: string): MissionHistoryArchiveReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Archive receipt must be an object");
  const object = value as Record<string, unknown>;
  const keys = Object.keys(object).sort();
  if (keys.length !== RECEIPT_KEYS.length || RECEIPT_KEYS.some((key, index) => keys[index] !== key)) {
    throw new Error("Archive receipt has an unexpected field set");
  }
  if (object.format !== "mission-history-archive-receipt/v1") throw new Error("Unsupported archive receipt format");
  if (object.eventFormat !== "mission-events/v1") throw new Error("Unsupported archive event format");
  if (object.canonicalization !== "canonical-json-v1+lf") throw new Error("Unsupported archive canonicalization");
  if (object.hashAlgorithm !== "sha256") throw new Error("Unsupported archive hash algorithm");
  if (typeof object.missionId !== "string" || !object.missionId.trim()) throw new Error("Archive receipt requires missionId");
  const throughSequence = nonNegativeSafeInteger(object.throughSequence, "throughSequence");
  const eventCount = nonNegativeSafeInteger(object.eventCount, "eventCount");
  const contentBytes = nonNegativeSafeInteger(object.contentBytes, "contentBytes");
  const expectedFromSequence = throughSequence === 0 ? 0 : 1;
  if (object.fromSequence !== expectedFromSequence) throw new Error("Archive receipt fromSequence is inconsistent");
  if (eventCount !== throughSequence) throw new Error("Archive receipt eventCount is inconsistent with throughSequence");
  if (typeof object.contentSha256 !== "string" || !OBJECT_ID_PATTERN.test(object.contentSha256)) {
    throw new Error("Archive receipt contentSha256 must be lowercase SHA-256 hex");
  }
  if (object.authorizesDeletion !== false) throw new Error("Archive receipt must not authorize deletion");
  if (typeof object.receiptSha256 !== "string" || !OBJECT_ID_PATTERN.test(object.receiptSha256)) {
    throw new Error("Archive receipt receiptSha256 must be lowercase SHA-256 hex");
  }
  if (object.receiptSha256 !== objectId) throw new Error("Archive object id does not match receipt SHA-256");

  const receipt = object as unknown as MissionHistoryArchiveReceipt;
  const core = receiptCore(receipt);
  const recalculated = createHash("sha256").update(canonicalJsonV1(core), "utf8").digest("hex");
  if (recalculated !== receipt.receiptSha256) {
    throw new Error(`Archive receipt SHA-256 mismatch: expected ${receipt.receiptSha256}, received ${recalculated}`);
  }
  if (receipt.contentBytes !== contentBytes || receipt.eventCount !== eventCount) {
    throw new Error("Archive receipt numeric normalization failed");
  }
  return receipt;
}

function receiptCore(receipt: MissionHistoryArchiveReceipt): MissionHistoryArchiveReceiptCore {
  const { receiptSha256: _receiptSha256, ...core } = receipt;
  return core;
}

function parseMissionEvent(lineBytes: Buffer): MissionEvent {
  let value: unknown;
  try {
    value = JSON.parse(lineBytes.toString("utf8"));
  } catch (error) {
    throw new Error(`Archive event JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Archive event must be an object");
  const event = value as Partial<MissionEvent>;
  if (typeof event.id !== "string" || !event.id) throw new Error("Archive event requires id");
  if (typeof event.missionId !== "string" || !event.missionId) throw new Error("Archive event requires missionId");
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1) throw new Error("Archive event requires positive sequence");
  if (typeof event.type !== "string" || !event.type) throw new Error("Archive event requires type");
  if (!event.actor || typeof event.actor !== "object" || Array.isArray(event.actor)) throw new Error("Archive event requires actor");
  if (!Number.isSafeInteger(event.schemaVersion) || Number(event.schemaVersion) < 1) throw new Error("Archive event requires schemaVersion");
  if (typeof event.createdAt !== "string" || !event.createdAt) throw new Error("Archive event requires createdAt");
  return value as MissionEvent;
}

function validateObjectId(objectId: string): void {
  if (!OBJECT_ID_PATTERN.test(objectId)) throw new Error("Archive object id must be lowercase SHA-256 hex");
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Archive receipt ${label} must be a non-negative safe integer`);
  }
  return value;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory`);
}

async function assertRegularFile(path: string, label: string) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
  return stat;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isExistingDestinationError(error: unknown): boolean {
  return isErrorCode(error, "EEXIST") || isErrorCode(error, "ENOTEMPTY");
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as Error & { code?: string }).code === code;
}

function assertSameReceipt(actual: MissionHistoryArchiveReceipt, expected: MissionHistoryArchiveReceipt): void {
  if (canonicalJsonV1(actual) !== canonicalJsonV1(expected)) {
    throw new Error(`Existing archive object ${expected.receiptSha256} does not match the requested receipt`);
  }
}
