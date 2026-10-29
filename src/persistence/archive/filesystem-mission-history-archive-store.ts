import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  canonicalJsonV1,
  canonicalMissionEventLine,
  MissionHistoryArchiveReceiptReader,
  type MissionHistoryArchiveReceipt
} from "../sqlite/mission-history-archive-receipt.ts";
import type { SqliteHistoryReader } from "../sqlite/sqlite-history-reader.ts";

const ARCHIVE_OBJECT_FORMAT = "mission-history-archive-object/v1" as const;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;
const EXPORT_PAGE_SIZE = 5000;

export interface MissionHistoryArchiveObjectManifest {
  format: typeof ARCHIVE_OBJECT_FORMAT;
  objectId: string;
  receipt: MissionHistoryArchiveReceipt;
}

export interface VerifiedMissionHistoryArchiveObject {
  objectId: string;
  receipt: MissionHistoryArchiveReceipt;
}

export interface CreateMissionHistoryArchiveOptions {
  throughSequence?: number;
}

/**
 * Immutable content-addressed filesystem store for verified Mission history
 * prefixes. Object paths are derived only from receipt SHA-256 identities;
 * Mission ids never participate in filesystem path construction.
 *
 * Archive integrity does not authorize Event Store deletion. This store proves
 * only that a frozen Mission Event prefix was materialized and can be verified
 * independently after process/database restart.
 */
export class FilesystemMissionHistoryArchiveStore {
  private readonly rootDir: string;
  private readonly objectsDir: string;
  private readonly stagingDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
    this.objectsDir = join(this.rootDir, "objects");
    this.stagingDir = join(this.rootDir, ".staging");
  }

  async createFromHistory(
    history: Pick<SqliteHistoryReader, "readExportPage">,
    missionId: string,
    options: CreateMissionHistoryArchiveOptions = {}
  ): Promise<VerifiedMissionHistoryArchiveObject | undefined> {
    const receiptReader = new MissionHistoryArchiveReceiptReader(history);
    const receipt = receiptReader.readReceipt(missionId, {
      ...(options.throughSequence === undefined ? {} : { throughSequence: options.throughSequence })
    });
    if (!receipt) return undefined;

    await this.ensureRoots();
    const objectId = validateObjectId(receipt.receiptSha256);
    const target = this.objectPath(objectId);

    if (await pathExists(target)) {
      const existing = await this.verifyObject(objectId);
      if (!sameReceipt(existing.receipt, receipt)) {
        throw new Error(`Archive object ${objectId} exists with a different receipt`);
      }
      return existing;
    }

    const staging = join(this.stagingDir, `${objectId}.${randomUUID()}`);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    try {
      await this.writeEvents(staging, history, receipt);
      await this.writeManifest(staging, objectId, receipt);
      const staged = await this.verifyDirectory(staging, objectId);
      if (!sameReceipt(staged.receipt, receipt)) {
        throw new Error(`Staged archive object ${objectId} receipt changed before publish`);
      }

      try {
        await rename(staging, target);
        await syncDirectory(this.objectsDir);
      } catch (error) {
        if (!isPublishConflict(error)) throw error;
        await rm(staging, { recursive: true, force: true });
        const winner = await this.verifyObject(objectId);
        if (!sameReceipt(winner.receipt, receipt)) {
          throw new Error(`Concurrent archive object ${objectId} has a different receipt`);
        }
        return winner;
      }

      return await this.verifyObject(objectId);
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async verifyObject(objectId: string): Promise<VerifiedMissionHistoryArchiveObject> {
    validateObjectId(objectId);
    await this.ensureRoots();
    return this.verifyDirectory(this.objectPath(objectId), objectId);
  }

  private async ensureRoots(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true, mode: 0o700 });
    await assertDirectoryNotSymlink(this.rootDir);
    await mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await assertDirectoryNotSymlink(this.objectsDir);
    await mkdir(this.stagingDir, { recursive: true, mode: 0o700 });
    await assertDirectoryNotSymlink(this.stagingDir);
  }

  private objectPath(objectId: string): string {
    return join(this.objectsDir, validateObjectId(objectId));
  }

  private async writeEvents(
    directory: string,
    history: Pick<SqliteHistoryReader, "readExportPage">,
    receipt: MissionHistoryArchiveReceipt
  ): Promise<void> {
    const path = join(directory, "events.jsonl");
    const handle = await open(path, "wx", 0o600);
    try {
      let afterSequence = 0;
      let writtenEvents = 0;
      while (afterSequence < receipt.throughSequence) {
        const page = history.readExportPage(receipt.missionId, {
          afterSequence,
          throughSequence: receipt.throughSequence,
          limit: EXPORT_PAGE_SIZE
        });
        if (!page) throw new Error(`Mission disappeared while archiving ${receipt.missionId}`);
        if (page.throughSequence !== receipt.throughSequence) {
          throw new Error(
            `Mission archive export boundary changed: expected ${receipt.throughSequence}, received ${page.throughSequence}`
          );
        }
        for (const event of page.events) {
          const line = canonicalMissionEventLine(event);
          if (Buffer.byteLength(line, "utf8") > MAX_EVENT_LINE_BYTES) {
            throw new Error(`Mission archive event line exceeds ${MAX_EVENT_LINE_BYTES} bytes at sequence ${event.sequence}`);
          }
          await handle.write(line, null, "utf8");
          writtenEvents += 1;
        }
        if (page.complete) break;
        if (page.nextAfterSequence === undefined || page.nextAfterSequence <= afterSequence) {
          throw new Error("Mission archive export did not advance its continuation sequence");
        }
        afterSequence = page.nextAfterSequence;
      }
      if (writtenEvents !== receipt.eventCount) {
        throw new Error(
          `Mission archive event count changed during write: expected ${receipt.eventCount}, wrote ${writtenEvents}`
        );
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  private async writeManifest(
    directory: string,
    objectId: string,
    receipt: MissionHistoryArchiveReceipt
  ): Promise<void> {
    const manifest: MissionHistoryArchiveObjectManifest = {
      format: ARCHIVE_OBJECT_FORMAT,
      objectId,
      receipt
    };
    const content = `${canonicalJsonV1(manifest)}\n`;
    if (Buffer.byteLength(content, "utf8") > MAX_MANIFEST_BYTES) {
      throw new Error("Mission archive manifest exceeds size limit");
    }
    const handle = await open(join(directory, "manifest.json"), "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
  }

  private async verifyDirectory(
    directory: string,
    expectedObjectId: string
  ): Promise<VerifiedMissionHistoryArchiveObject> {
    await assertDirectoryNotSymlink(directory);
    const manifestPath = join(directory, "manifest.json");
    const eventsPath = join(directory, "events.jsonl");
    await assertRegularFileNotSymlink(manifestPath);
    await assertRegularFileNotSymlink(eventsPath);

    const manifestStat = await stat(manifestPath);
    if (manifestStat.size > MAX_MANIFEST_BYTES) {
      throw new Error(`Archive object ${expectedObjectId} manifest exceeds size limit`);
    }
    const manifestRaw = await readFile(manifestPath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(manifestRaw);
    } catch (error) {
      throw new Error(`Archive object ${expectedObjectId} has invalid manifest JSON: ${errorMessage(error)}`);
    }
    const manifest = validateManifest(parsed, expectedObjectId);
    const expectedManifestRaw = `${canonicalJsonV1(manifest)}\n`;
    if (manifestRaw !== expectedManifestRaw) {
      throw new Error(`Archive object ${expectedObjectId} manifest is not canonical JSON`);
    }

    validateReceipt(manifest.receipt, expectedObjectId);
    await verifyEventsFile(eventsPath, manifest.receipt);
    return { objectId: expectedObjectId, receipt: manifest.receipt };
  }
}

async function verifyEventsFile(path: string, receipt: MissionHistoryArchiveReceipt): Promise<void> {
  const hash = createHash("sha256");
  let bytes = 0;
  let pending = "";
  let eventCount = 0;
  let expectedSequence = receipt.fromSequence === 0 ? 0 : 1;

  const input = createReadStream(path, { encoding: "utf8" });
  for await (const chunk of input) {
    const text = String(chunk);
    hash.update(text, "utf8");
    bytes += Buffer.byteLength(text, "utf8");
    pending += text;

    let newline: number;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line, "utf8") + 1 > MAX_EVENT_LINE_BYTES) {
        throw new Error(`Archive event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
      }
      if (!line) throw new Error("Archive events file contains an empty event line");
      const event = parseCanonicalEventLine(line);
      if (receipt.fromSequence === 0) {
        throw new Error("Archive receipt declares an empty prefix but events file is not empty");
      }
      if (event.missionId !== receipt.missionId) {
        throw new Error(
          `Archive event Mission mismatch: expected ${receipt.missionId}, received ${String(event.missionId)}`
        );
      }
      if (event.sequence !== expectedSequence) {
        throw new Error(
          `Archive event sequence mismatch: expected ${expectedSequence}, received ${String(event.sequence)}`
        );
      }
      expectedSequence += 1;
      eventCount += 1;
    }
    if (Buffer.byteLength(pending, "utf8") > MAX_EVENT_LINE_BYTES) {
      throw new Error(`Archive event line exceeds ${MAX_EVENT_LINE_BYTES} bytes`);
    }
  }

  if (pending.length !== 0) throw new Error("Archive events file must end with a trailing LF");
  const contentSha256 = hash.digest("hex");
  if (bytes !== receipt.contentBytes) {
    throw new Error(`Archive content byte mismatch: expected ${receipt.contentBytes}, received ${bytes}`);
  }
  if (contentSha256 !== receipt.contentSha256) {
    throw new Error(`Archive content SHA-256 mismatch: expected ${receipt.contentSha256}, received ${contentSha256}`);
  }
  if (eventCount !== receipt.eventCount) {
    throw new Error(`Archive event count mismatch: expected ${receipt.eventCount}, received ${eventCount}`);
  }
  if (receipt.throughSequence === 0) {
    if (eventCount !== 0 || receipt.fromSequence !== 0) {
      throw new Error("Empty archive prefix has inconsistent receipt fields");
    }
  } else if (expectedSequence !== receipt.throughSequence + 1) {
    throw new Error(
      `Archive event prefix ended at sequence ${expectedSequence - 1}, expected ${receipt.throughSequence}`
    );
  }
}

function parseCanonicalEventLine(line: string): { missionId?: unknown; sequence?: unknown } {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error(`Archive event line is invalid JSON: ${errorMessage(error)}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Archive event line must contain a JSON object");
  }
  if (canonicalJsonV1(value) !== line) {
    throw new Error("Archive event line is not canonical JSON");
  }
  const event = value as { missionId?: unknown; sequence?: unknown };
  if (typeof event.missionId !== "string" || !event.missionId) {
    throw new Error("Archive event line is missing missionId");
  }
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1) {
    throw new Error("Archive event line has invalid sequence");
  }
  return event;
}

function validateManifest(value: unknown, expectedObjectId: string): MissionHistoryArchiveObjectManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Archive object ${expectedObjectId} manifest must be an object`);
  }
  const object = value as Record<string, unknown>;
  if (object.format !== ARCHIVE_OBJECT_FORMAT) {
    throw new Error(`Archive object ${expectedObjectId} has unsupported manifest format`);
  }
  if (object.objectId !== expectedObjectId) {
    throw new Error(`Archive object id mismatch: expected ${expectedObjectId}, received ${String(object.objectId)}`);
  }
  if (!object.receipt || typeof object.receipt !== "object" || Array.isArray(object.receipt)) {
    throw new Error(`Archive object ${expectedObjectId} manifest is missing receipt`);
  }
  const allowed = new Set(["format", "objectId", "receipt"]);
  if (Object.keys(object).some(key => !allowed.has(key))) {
    throw new Error(`Archive object ${expectedObjectId} manifest contains unsupported fields`);
  }
  return object as unknown as MissionHistoryArchiveObjectManifest;
}

function validateReceipt(receipt: MissionHistoryArchiveReceipt, expectedObjectId: string): void {
  const receiptObject = receipt as unknown as Record<string, unknown>;
  const allowedReceiptFields = new Set([
    "format",
    "eventFormat",
    "canonicalization",
    "hashAlgorithm",
    "missionId",
    "fromSequence",
    "throughSequence",
    "eventCount",
    "contentBytes",
    "contentSha256",
    "authorizesDeletion",
    "receiptSha256"
  ]);
  if (Object.keys(receiptObject).some(key => !allowedReceiptFields.has(key))) {
    throw new Error("Archive receipt contains unsupported fields");
  }
  if (receipt.format !== "mission-history-archive-receipt/v1") throw new Error("Archive receipt format mismatch");
  if (receipt.eventFormat !== "mission-events/v1") throw new Error("Archive receipt event format mismatch");
  if (receipt.canonicalization !== "canonical-json-v1+lf") throw new Error("Archive receipt canonicalization mismatch");
  if (receipt.hashAlgorithm !== "sha256") throw new Error("Archive receipt hash algorithm mismatch");
  if (receipt.authorizesDeletion !== false) throw new Error("Archive receipt must never authorize Event Store deletion");
  if (!HASH_RE.test(receipt.contentSha256)) throw new Error("Archive receipt content SHA-256 is invalid");
  if (!HASH_RE.test(receipt.receiptSha256)) throw new Error("Archive receipt SHA-256 is invalid");
  if (receipt.receiptSha256 !== expectedObjectId) throw new Error("Archive receipt identity does not match object id");
  if (!Number.isSafeInteger(receipt.throughSequence) || receipt.throughSequence < 0) {
    throw new Error("Archive receipt throughSequence is invalid");
  }
  if (!Number.isSafeInteger(receipt.eventCount) || receipt.eventCount < 0) {
    throw new Error("Archive receipt eventCount is invalid");
  }
  if (!Number.isSafeInteger(receipt.contentBytes) || receipt.contentBytes < 0) {
    throw new Error("Archive receipt contentBytes is invalid");
  }
  if (typeof receipt.missionId !== "string" || !receipt.missionId) throw new Error("Archive receipt missionId is invalid");
  if (receipt.throughSequence === 0) {
    if (receipt.fromSequence !== 0 || receipt.eventCount !== 0) {
      throw new Error("Empty archive receipt prefix fields are inconsistent");
    }
  } else if (receipt.fromSequence !== 1 || receipt.eventCount !== receipt.throughSequence) {
    throw new Error("Archive receipt prefix fields are inconsistent");
  }
  const { receiptSha256, ...core } = receipt;
  const actual = createHash("sha256").update(canonicalJsonV1(core), "utf8").digest("hex");
  if (actual !== receiptSha256) {
    throw new Error(`Archive receipt SHA-256 mismatch: expected ${receiptSha256}, received ${actual}`);
  }
}

function validateObjectId(value: string): string {
  if (!HASH_RE.test(value)) throw new Error("Archive object id must be a lowercase SHA-256 hex digest");
  return value;
}

function sameReceipt(left: MissionHistoryArchiveReceipt, right: MissionHistoryArchiveReceipt): boolean {
  return canonicalJsonV1(left) === canonicalJsonV1(right);
}

async function assertDirectoryNotSymlink(path: string): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink() || !value.isDirectory()) throw new Error(`Archive path is not a real directory: ${path}`);
}

async function assertRegularFileNotSymlink(path: string): Promise<void> {
  const value = await lstat(path);
  if (value.isSymbolicLink() || !value.isFile()) throw new Error(`Archive path is not a regular file: ${path}`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isNotFound(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isPublishConflict(error: unknown): boolean {
  return isNodeError(error) && (error.code === "EEXIST" || error.code === "ENOTEMPTY");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
