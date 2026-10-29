import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FileMissionHistoryArchiveStore } from "../../src/persistence/archive/file-mission-history-archive-store.ts";
import { canonicalJsonV1, type MissionHistoryArchiveReceiptCore } from "../../src/persistence/sqlite/mission-history-archive-receipt.ts";

const MAX_EVENT_LINE_BYTES = 16 * 1024 * 1024;

test("archive verification rejects an oversized unterminated event line before unbounded accumulation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-history-archive-line-bound-"));
  try {
    const oversized = Buffer.alloc(MAX_EVENT_LINE_BYTES + 1, 0x78);
    const core: MissionHistoryArchiveReceiptCore = {
      format: "mission-history-archive-receipt/v1",
      eventFormat: "mission-events/v1",
      canonicalization: "canonical-json-v1+lf",
      hashAlgorithm: "sha256",
      missionId: "mission-oversized-archive-line",
      fromSequence: 1,
      throughSequence: 1,
      eventCount: 1,
      contentBytes: oversized.length,
      contentSha256: createHash("sha256").update(oversized).digest("hex"),
      authorizesDeletion: false
    };
    const receiptSha256 = createHash("sha256").update(canonicalJsonV1(core), "utf8").digest("hex");
    const objectDir = join(root, "objects", receiptSha256.slice(0, 2), receiptSha256);
    await mkdir(objectDir, { recursive: true });
    await writeFile(
      join(objectDir, "receipt.json"),
      `${canonicalJsonV1({ ...core, receiptSha256 })}\n`,
      "utf8"
    );
    await writeFile(join(objectDir, "events.jsonl"), oversized);

    const store = new FileMissionHistoryArchiveStore(root);
    await assert.rejects(
      () => store.verify(receiptSha256),
      /event line exceeds 16777216 canonical bytes/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
