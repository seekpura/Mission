import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import { createDefaultVerificationProfileRegistry } from "../../src/core/verification/verification-profile.ts";
import { createDefaultVerificationEvidenceCollectorRegistry } from "../../src/runtime/verification-evidence-collectors.ts";

function artifact(path: string, type: Artifact["type"], mimeType?: string): Artifact {
  const bytes = readFileSync(path);
  return {
    id: `artifact-${type}`,
    missionId: "mission-builtins",
    logicalName: "fixture",
    type,
    version: 1,
    status: "candidate",
    uri: path,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    ...(mimeType ? { mimeType } : {}),
    sizeBytes: bytes.length,
    producedByAttemptId: "attempt-builtins",
    sourceArtifactRefs: [],
    createdAt: "2026-10-29T00:00:00.000Z"
  };
}

test("PPTX package collector extracts bounded ordered slide text without claiming rendered quality", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-evidence-pptx-"));
  try {
    const path = join(root, "deck.pptx");
    writeFileSync(path, makeStoredZip([
      ["ppt/slides/slide2.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>Second slide</a:t></p:sld>'],
      ["ppt/slides/slide1.xml", '<p:sld xmlns:p="p" xmlns:a="a"><a:t>First</a:t><a:t>Slide</a:t></p:sld>']
    ]));
    const value = artifact(path, "presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const profile = createDefaultVerificationProfileRegistry().select(value).profile;
    const result = await createDefaultVerificationEvidenceCollectorRegistry().collect({
      artifact: value,
      profile,
      maxInspectionBytes: 32 * 1024
    });

    assert.deepEqual(result.failures, []);
    const packageEvidence = result.collected.find(item => item.draft.kind === "presentation-package");
    assert.ok(packageEvidence);
    assert.equal(packageEvidence?.draft.result, "supports");
    assert.equal(packageEvidence?.draft.details?.slideCount, 2);
    assert.deepEqual((packageEvidence?.draft.inspectionPayload as any).slides, [
      { slide: 1, text: "First\nSlide" },
      { slide: 2, text: "Second slide" }
    ]);
    assert.equal(result.collected.some(item => item.draft.kind === "presentation-render"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed PPTX is isolated as collector failure rather than promoted to presentation-package Evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-evidence-bad-pptx-"));
  try {
    const path = join(root, "broken.pptx");
    writeFileSync(path, "this is not a zip package", "utf8");
    const value = artifact(path, "presentation", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const profile = createDefaultVerificationProfileRegistry().select(value).profile;
    const result = await createDefaultVerificationEvidenceCollectorRegistry().collect({ artifact: value, profile, maxInspectionBytes: 4096 });

    assert.ok(result.collected.some(item => item.draft.kind === "file-integrity"));
    assert.equal(result.collected.some(item => item.draft.kind === "presentation-package"), false);
    const failure = result.failures.find(item => item.collectorId === "runtime-pptx-package-v1");
    assert.ok(failure);
    assert.match(failure?.reason ?? "", /end-of-central-directory/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("research trace collector strips credentials, query and fragment from transient source refs", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-evidence-research-"));
  try {
    const path = join(root, "research.md");
    writeFileSync(
      path,
      "Claim [1]. Source: https://user:password@example.com/report?token=secret#private\n",
      "utf8"
    );
    const value = artifact(path, "research", "text/markdown");
    const profile = createDefaultVerificationProfileRegistry().select(value).profile;
    const result = await createDefaultVerificationEvidenceCollectorRegistry().collect({ artifact: value, profile, maxInspectionBytes: 8192 });
    const trace = result.collected.find(item => item.draft.kind === "source-traceability");

    assert.ok(trace);
    assert.equal(trace?.draft.result, "supports");
    const refs = (trace?.draft.inspectionPayload as any).sourceRefs as string[];
    assert.deepEqual(refs, ["https://example.com/report"]);
    assert.equal(JSON.stringify(trace?.draft).includes("password"), false);
    assert.equal(JSON.stringify(trace?.draft).includes("token=secret"), false);
    assert.equal(trace?.draft.details?.sourceRecencyValidated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("website static collectors never fabricate browser-runtime or accessibility evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-evidence-website-"));
  try {
    const path = join(root, "index.html");
    writeFileSync(path, "<!doctype html><main><h1>Hello</h1><button>Go</button></main>", "utf8");
    const value = artifact(path, "website", "text/html");
    const profile = createDefaultVerificationProfileRegistry().select(value).profile;
    const result = await createDefaultVerificationEvidenceCollectorRegistry().collect({ artifact: value, profile, maxInspectionBytes: 8192 });
    const kinds = result.collected.map(item => item.draft.kind);

    assert.ok(kinds.includes("website-source"));
    assert.equal(kinds.includes("browser-runtime"), false);
    assert.equal(kinds.includes("accessibility-check"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeStoredZip(entries: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let localOffset = 0;

  for (const [name, body] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const data = Buffer.from(body, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);
    centrals.push(central, nameBytes);
    localOffset += local.length + nameBytes.length + data.length;
  }

  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, eocd]);
}
