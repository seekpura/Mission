import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { Artifact } from "../core/domain/artifact.ts";
import {
  VerificationEvidenceCollectorRegistry,
  type VerificationEvidenceCollector,
  type VerificationEvidenceCollectorInput,
  type VerificationEvidenceDraft
} from "../core/verification/evidence-collector.ts";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".html", ".htm", ".css", ".json", ".yaml", ".yml", ".xml", ".csv",
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".rb", ".php",
  ".cs", ".cpp", ".c", ".h", ".sh"
]);

export function createDefaultVerificationEvidenceCollectorRegistry(
  additionalCollectors: VerificationEvidenceCollector[] = []
): VerificationEvidenceCollectorRegistry {
  return new VerificationEvidenceCollectorRegistry([
    new FileIntegrityEvidenceCollector(),
    new BoundedTextContentEvidenceCollector(),
    new WebsiteSourceEvidenceCollector(),
    new CodeSourceEvidenceCollector(),
    new ResearchSourceTraceabilityEvidenceCollector(),
    new PresentationPackageEvidenceCollector(),
    ...additionalCollectors
  ]);
}

class FileIntegrityEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-file-integrity-v1";
  readonly kinds = ["file-integrity"] as const;

  supports(): boolean { return true; }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const artifact = input.artifact;
    const exists = existsSync(artifact.uri);
    const isFile = exists && statSync(artifact.uri).isFile();
    const size = isFile ? statSync(artifact.uri).size : 0;
    const actual = isFile ? createHash("sha256").update(readFileSync(artifact.uri)).digest("hex") : "";
    const expected = normalizeHash(artifact.contentHash);
    const matches = Boolean(actual) && actual === expected;
    return [{
      type: "file-validation",
      kind: "file-integrity",
      claim: matches
        ? "Artifact is a regular non-empty file whose current bytes match the committed SHA-256."
        : "Artifact file integrity does not match the committed artifact identity.",
      result: exists && isFile && size > 0 && matches ? "supports" : "contradicts",
      ...(exists ? { sourceRef: `file:${artifact.uri}` } : {}),
      details: {
        exists,
        regularFile: isFile,
        sizeBytes: size,
        hashMatches: matches,
        ...(actual ? { actualHash: `sha256:${actual}` } : {})
      }
    }];
  }
}

class BoundedTextContentEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-bounded-text-v1";
  readonly kinds = ["text-content"] as const;

  supports(input: VerificationEvidenceCollectorInput): boolean {
    return isTextLike(input.artifact);
  }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const text = readBoundedText(input.artifact, input.maxInspectionBytes);
    if (!text) return [];
    return [{
      type: "source",
      kind: "text-content",
      claim: "Runtime decoded the artifact as bounded UTF-8 text for independent content inspection.",
      result: "supports",
      sourceRef: `file:${input.artifact.uri}`,
      details: {
        byteLength: Buffer.byteLength(text, "utf8"),
        characterCount: text.length,
        lineCount: lineCount(text),
        truncated: statSync(input.artifact.uri).size > Buffer.byteLength(text, "utf8")
      },
      inspectionPayload: { text }
    }];
  }
}

class WebsiteSourceEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-website-source-v1";
  readonly kinds = ["website-source"] as const;

  supports(input: VerificationEvidenceCollectorInput): boolean {
    return input.profile.kind === "website" && isTextLike(input.artifact);
  }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const text = readBoundedText(input.artifact, input.maxInspectionBytes);
    if (!text) return [];
    const tags = (name: string) => (text.match(new RegExp(`<${name}\\b`, "gi")) ?? []).length;
    const links = [...text.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi)]
      .slice(0, 128)
      .map(match => match[1] ?? "")
      .filter(Boolean);
    return [{
      type: "source",
      kind: "website-source",
      claim: "Runtime inspected bounded website source structure; this is static source evidence and does not prove browser behavior.",
      result: "supports",
      sourceRef: `file:${input.artifact.uri}`,
      details: {
        htmlBytesInspected: Buffer.byteLength(text, "utf8"),
        links: links.length,
        forms: tags("form"),
        buttons: tags("button"),
        scripts: tags("script"),
        navLandmarks: tags("nav"),
        mainLandmarks: tags("main"),
        headings: tags("h1") + tags("h2") + tags("h3") + tags("h4") + tags("h5") + tags("h6")
      },
      inspectionPayload: { links }
    }];
  }
}

class CodeSourceEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-code-source-v1";
  readonly kinds = ["code-source"] as const;

  supports(input: VerificationEvidenceCollectorInput): boolean {
    return input.profile.kind === "code" && isTextLike(input.artifact);
  }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const text = readBoundedText(input.artifact, input.maxInspectionBytes);
    if (!text) return [];
    return [{
      type: "source",
      kind: "code-source",
      claim: "Runtime decoded bounded source code for independent inspection; this does not assert that tests, builds or integrations passed.",
      result: "supports",
      sourceRef: `file:${input.artifact.uri}`,
      details: {
        extension: extname(input.artifact.uri).toLowerCase(),
        lineCount: lineCount(text),
        byteLength: Buffer.byteLength(text, "utf8")
      },
      inspectionPayload: { source: text }
    }];
  }
}

class ResearchSourceTraceabilityEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-research-source-trace-v1";
  readonly kinds = ["source-traceability"] as const;

  supports(input: VerificationEvidenceCollectorInput): boolean {
    return input.profile.kind === "research" && isTextLike(input.artifact);
  }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const text = readBoundedText(input.artifact, input.maxInspectionBytes);
    if (!text) return [];
    const urls = unique(
      [...text.matchAll(/https?:\/\/[^\s<>()\]"']+/gi)]
        .map(match => sanitizeSourceUrl(match[0]))
        .filter((value): value is string => Boolean(value))
    ).slice(0, 128);
    const markdownLinks = (text.match(/\[[^\]]+\]\([^\)]+\)/g) ?? []).length;
    const footnoteRefs = (text.match(/\[\^[^\]]+\]/g) ?? []).length;
    const numberedCitations = (text.match(/\[(?:\d+)(?:\s*[-,]\s*\d+)*\]/g) ?? []).length;
    const traceCount = urls.length + markdownLinks + footnoteRefs + numberedCitations;
    return [{
      type: "source",
      kind: "source-traceability",
      claim: traceCount > 0
        ? "Runtime found explicit source/citation references that can be inspected for claim traceability."
        : "Runtime found no explicit source/citation references in the bounded research text.",
      result: traceCount > 0 ? "supports" : "inconclusive",
      sourceRef: `file:${input.artifact.uri}`,
      details: {
        explicitHttpSources: urls.length,
        markdownLinks,
        footnoteReferences: footnoteRefs,
        numberedCitations,
        sourceAuthorityValidated: false,
        sourceRecencyValidated: false
      },
      inspectionPayload: { sourceRefs: urls }
    }];
  }
}

class PresentationPackageEvidenceCollector implements VerificationEvidenceCollector {
  readonly id = "runtime-pptx-package-v1";
  readonly kinds = ["presentation-package"] as const;

  supports(input: VerificationEvidenceCollectorInput): boolean {
    const extension = extname(input.artifact.uri).toLowerCase();
    const mime = input.artifact.mimeType?.toLowerCase() ?? "";
    return input.profile.kind === "presentation" &&
      (extension === ".pptx" || mime.startsWith("application/vnd.openxmlformats-officedocument.presentationml.presentation"));
  }

  collect(input: VerificationEvidenceCollectorInput): VerificationEvidenceDraft[] {
    const info = statSync(input.artifact.uri);
    if (info.size > 96 * 1024 * 1024) {
      throw new Error(`PPTX package exceeds 96 MiB deterministic inspection limit: ${info.size}`);
    }
    const slides = extractPptxSlides(readFileSync(input.artifact.uri));
    if (slides.length === 0) {
      return [{
        type: "file-validation",
        kind: "presentation-package",
        claim: "OOXML presentation package contained no inspectable slide XML parts.",
        result: "contradicts",
        sourceRef: `file:${input.artifact.uri}`,
        details: { slideCount: 0, packageBytes: info.size }
      }];
    }
    const payload = boundSlideInspection(slides, input.maxInspectionBytes);
    return [{
      type: "source",
      kind: "presentation-package",
      claim: `Runtime parsed ${slides.length} ordered OOXML slide part(s) and extracted bounded slide text for structural/content inspection.`,
      result: "supports",
      sourceRef: `file:${input.artifact.uri}`,
      details: {
        slideCount: slides.length,
        packageBytes: info.size,
        slidesWithText: slides.filter(slide => slide.text.trim()).length,
        inspectionTruncated: payload.truncated
      },
      inspectionPayload: { slides: payload.slides }
    }];
  }
}

function isTextLike(artifact: Artifact): boolean {
  const mime = artifact.mimeType?.toLowerCase() ?? "";
  if (mime.startsWith("text/") || mime.includes("json") || mime.includes("javascript") || mime.includes("typescript") || mime.includes("xml")) return true;
  if (artifact.type === "code" || artifact.type === "research" || artifact.type === "website") return true;
  return TEXT_EXTENSIONS.has(extname(artifact.uri).toLowerCase());
}

function readBoundedText(artifact: Artifact, maxBytes: number): string | undefined {
  if (!existsSync(artifact.uri)) return undefined;
  const info = statSync(artifact.uri);
  if (!info.isFile()) return undefined;
  const bytes = readFileSync(artifact.uri);
  if (bytes.includes(0)) return undefined;
  const bounded = bytes.subarray(0, Math.min(bytes.length, Math.max(1_024, maxBytes)));
  const text = bounded.toString("utf8");
  const replacements = [...text].filter(character => character === "�").length;
  if (replacements > Math.max(2, text.length / 200)) return undefined;
  return text;
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return (text.match(/\n/g) ?? []).length + 1;
}

function normalizeHash(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length) : value;
}

function sanitizeSourceUrl(value: string): string | undefined {
  try {
    const url = new URL(value.replace(/[.,;:!?]+$/, ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

interface SlideText {
  slide: number;
  text: string;
}

function extractPptxSlides(bytes: Buffer): SlideText[] {
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = bytes.readUInt16LE(eocd + 4);
  const centralDisk = bytes.readUInt16LE(eocd + 6);
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8);
  const totalEntries = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new Error("Multi-disk/ZIP64 presentation packages are not accepted by the deterministic PPTX collector");
  }
  if (totalEntries > 4096) throw new Error(`PPTX package has too many ZIP entries: ${totalEntries}`);
  if (centralOffset + centralSize > bytes.length) throw new Error("PPTX central directory exceeds package bounds");

  const slides: Array<{ slide: number; method: number; flags: number; compressed: number; uncompressed: number; localOffset: number }> = [];
  let cursor = centralOffset;
  let declaredSlideBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    requireRange(bytes, cursor, 46, "central directory entry");
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error("Invalid PPTX ZIP central directory signature");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const compressed = bytes.readUInt32LE(cursor + 20);
    const uncompressed = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    requireRange(bytes, cursor + 46, nameLength + extraLength + commentLength, "central directory variable fields");
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const match = /^ppt\/slides\/slide(\d+)\.xml$/i.exec(name);
    if (match) {
      if ((flags & 0x1) !== 0) throw new Error(`Encrypted PPTX slide part is unsupported: ${name}`);
      if (method !== 0 && method !== 8) throw new Error(`Unsupported PPTX slide compression method ${method}: ${name}`);
      if (uncompressed > 2 * 1024 * 1024) throw new Error(`PPTX slide XML exceeds 2 MiB limit: ${name}`);
      declaredSlideBytes += uncompressed;
      if (declaredSlideBytes > 32 * 1024 * 1024) throw new Error("PPTX aggregate slide XML exceeds 32 MiB limit");
      slides.push({ slide: Number(match[1]), method, flags, compressed, uncompressed, localOffset });
    }
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  if (slides.length > 1024) throw new Error(`PPTX has too many slide parts: ${slides.length}`);

  return slides
    .sort((a, b) => a.slide - b.slide)
    .map(entry => ({ slide: entry.slide, text: extractSlideText(readZipEntry(bytes, entry)) }));
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const start = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("PPTX ZIP end-of-central-directory record not found");
}

function readZipEntry(
  bytes: Buffer,
  entry: { method: number; compressed: number; uncompressed: number; localOffset: number }
): Buffer {
  requireRange(bytes, entry.localOffset, 30, "local ZIP header");
  if (bytes.readUInt32LE(entry.localOffset) !== 0x04034b50) throw new Error("Invalid PPTX ZIP local-header signature");
  const nameLength = bytes.readUInt16LE(entry.localOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localOffset + 28);
  const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
  requireRange(bytes, dataOffset, entry.compressed, "compressed slide XML");
  const compressed = bytes.subarray(dataOffset, dataOffset + entry.compressed);
  const output = entry.method === 0
    ? Buffer.from(compressed)
    : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressed + 1) });
  if (output.length !== entry.uncompressed) {
    throw new Error(`PPTX slide size mismatch: expected ${entry.uncompressed}, decoded ${output.length}`);
  }
  return output;
}

function requireRange(bytes: Buffer, offset: number, length: number, label: string): void {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
    throw new Error(`PPTX ${label} exceeds package bounds`);
  }
}

function extractSlideText(xml: Buffer): string {
  const source = xml.toString("utf8");
  const values: string[] = [];
  for (const match of source.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi)) {
    values.push(xmlUnescape(match[1] ?? "").trim());
  }
  return values.filter(Boolean).join("\n");
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, decimal: string) => safeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return "�";
  return String.fromCodePoint(value);
}

function boundSlideInspection(slides: SlideText[], maxBytes: number): { slides: SlideText[]; truncated: boolean } {
  const limit = Math.max(4_096, maxBytes);
  const output: SlideText[] = [];
  let used = 0;
  let truncated = false;
  for (const slide of slides) {
    const prefixBytes = 32;
    const remaining = limit - used - prefixBytes;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const text = truncateUtf8(slide.text, Math.min(remaining, 16 * 1024));
    if (Buffer.byteLength(text, "utf8") < Buffer.byteLength(slide.text, "utf8")) truncated = true;
    output.push({ slide: slide.slide, text });
    used += prefixBytes + Buffer.byteLength(text, "utf8");
  }
  if (output.length < slides.length) truncated = true;
  return { slides: output, truncated };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  let end = Math.max(0, maxBytes);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
