import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type {
  CapabilityCandidate,
  CapabilityDescriptor,
  SecurityAssessment
} from "../domain/capability.ts";
import type { CapabilitySourceIdentity } from "../domain/capability-ledger.ts";
import type { PolicyDecision } from "../policy/policy-engine.ts";
import type { CapabilitySmokeResult } from "./sandbox/isolated-smoke-runner.ts";

export interface TrustedCapabilityCacheRecord {
  schemaVersion: 1;
  cacheKey: string;
  identity: CapabilitySourceIdentity;
  candidate: Pick<CapabilityCandidate, "sourceType" | "sourceUri" | "name" | "candidateKind">;
  capability: Omit<CapabilityDescriptor, "invocationRef" | "scope" | "available">;
  security: SecurityAssessment;
  policy: PolicyDecision;
  smoke: CapabilitySmokeResult;
  bundleContentHash: string;
  createdAt: string;
}

export interface TrustedCapabilityCacheHit {
  record: TrustedCapabilityCacheRecord;
  bundleRoot: string;
}

export interface TrustedCapabilityCacheStoreInput {
  identity: CapabilitySourceIdentity;
  candidate: CapabilityCandidate;
  capability: CapabilityDescriptor;
  security: SecurityAssessment;
  policy: PolicyDecision;
  smoke: CapabilitySmokeResult;
}

export interface TrustedCapabilityCache {
  find(identity: CapabilitySourceIdentity): Promise<TrustedCapabilityCacheHit | undefined> | TrustedCapabilityCacheHit | undefined;
  store(input: TrustedCapabilityCacheStoreInput): Promise<TrustedCapabilityCacheRecord> | TrustedCapabilityCacheRecord;
  revoke(cacheKey: string, reason: string): Promise<void> | void;
}

export interface FileTrustedCapabilityCacheOptions {
  maxBundleFiles?: number;
  maxBundleBytes?: number;
}

/**
 * Immutable cache of the minimal already-activated capability bundle. Cache
 * identity is bound to source URI + immutable revision + source content hash.
 * Approval is deliberately not cached: each Mission still makes its own
 * activation decision while exact bytes may reuse prior scan/smoke evidence.
 */
export class FileTrustedCapabilityCache implements TrustedCapabilityCache {
  private readonly root: string;
  private readonly maxBundleFiles: number;
  private readonly maxBundleBytes: number;

  constructor(root: string, options: FileTrustedCapabilityCacheOptions = {}) {
    this.root = resolve(root);
    this.maxBundleFiles = Math.max(1, options.maxBundleFiles ?? 256);
    this.maxBundleBytes = Math.max(1_024, options.maxBundleBytes ?? 8 * 1024 * 1024);
    mkdirSync(this.root, { recursive: true });
    mkdirSync(join(this.root, ".staging"), { recursive: true });
  }

  find(identity: CapabilitySourceIdentity): TrustedCapabilityCacheHit | undefined {
    validateIdentity(identity);
    const cacheKey = capabilityCacheKey(identity);
    const dir = join(this.root, cacheKey);
    if (!existsSync(dir)) return undefined;
    if (existsSync(join(dir, "revoked.json"))) return undefined;

    const recordPath = join(dir, "record.json");
    const bundleRoot = join(dir, "bundle");
    if (!existsSync(recordPath) || !existsSync(bundleRoot)) {
      throw new Error(`Trusted capability cache entry is incomplete: ${cacheKey}`);
    }
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as TrustedCapabilityCacheRecord;
    validateRecord(record, identity, cacheKey);
    const actualBundleHash = hashBundle(bundleRoot, this.maxBundleFiles, this.maxBundleBytes);
    if (actualBundleHash !== record.bundleContentHash) {
      throw new Error(`Trusted capability cache bundle hash mismatch: ${cacheKey}`);
    }
    return { record, bundleRoot };
  }

  store(input: TrustedCapabilityCacheStoreInput): TrustedCapabilityCacheRecord {
    validateIdentity(input.identity);
    if (!input.capability.invocationRef) {
      throw new Error(`Capability ${input.capability.id} has no activation directory to cache`);
    }
    const source = resolve(input.capability.invocationRef);
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new Error(`Capability activation directory is unavailable for cache: ${source}`);
    }

    const cacheKey = capabilityCacheKey(input.identity);
    const existing = this.find(input.identity);
    if (existing) return existing.record;

    const staging = join(this.root, ".staging", `${cacheKey}-${randomUUID()}`);
    const bundleRoot = join(staging, "bundle");
    mkdirSync(staging, { recursive: false });
    try {
      cpSync(source, bundleRoot, { recursive: true, dereference: false, errorOnExist: false });
      const bundleContentHash = hashBundle(bundleRoot, this.maxBundleFiles, this.maxBundleBytes);
      const { invocationRef: _invocationRef, scope: _scope, available: _available, ...capability } = input.capability;
      const record: TrustedCapabilityCacheRecord = {
        schemaVersion: 1,
        cacheKey,
        identity: { ...input.identity },
        candidate: {
          sourceType: input.candidate.sourceType,
          sourceUri: input.candidate.sourceUri,
          name: input.candidate.name,
          candidateKind: input.candidate.candidateKind
        },
        capability,
        security: structuredClone(input.security),
        policy: structuredClone(input.policy),
        smoke: structuredClone(input.smoke),
        bundleContentHash,
        createdAt: new Date().toISOString()
      };
      writeFileSync(join(staging, "record.json"), `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
      const destination = join(this.root, cacheKey);
      try {
        renameSync(staging, destination);
      } catch (error) {
        if (!existsSync(destination)) throw error;
        rmSync(staging, { recursive: true, force: true });
        const raced = this.find(input.identity);
        if (!raced) throw new Error(`Trusted capability cache race produced no valid entry: ${cacheKey}`);
        return raced.record;
      }
      return record;
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }

  revoke(cacheKey: string, reason: string): void {
    if (!/^[0-9a-f]{64}$/.test(cacheKey)) throw new Error(`Invalid trusted capability cache key: ${cacheKey}`);
    if (!reason.trim()) throw new Error("Trusted capability cache revocation requires a reason");
    const dir = join(this.root, cacheKey);
    if (!existsSync(dir)) throw new Error(`Trusted capability cache entry not found: ${cacheKey}`);
    const path = join(dir, "revoked.json");
    if (existsSync(path)) return;
    writeFileSync(path, `${JSON.stringify({ reason: reason.trim(), revokedAt: new Date().toISOString() }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx"
    });
  }
}

export function capabilityCacheKey(identity: CapabilitySourceIdentity): string {
  validateIdentity(identity);
  return createHash("sha256").update(stableJson(identity)).digest("hex");
}

function validateRecord(
  record: TrustedCapabilityCacheRecord,
  identity: CapabilitySourceIdentity,
  cacheKey: string
): void {
  if (record.schemaVersion !== 1) throw new Error(`Unsupported trusted capability cache schema: ${record.schemaVersion}`);
  if (record.cacheKey !== cacheKey) throw new Error(`Trusted capability cache key mismatch: ${cacheKey}`);
  if (stableJson(record.identity) !== stableJson(identity)) {
    throw new Error(`Trusted capability cache identity mismatch: ${cacheKey}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(record.bundleContentHash)) {
    throw new Error(`Trusted capability cache has invalid bundle hash: ${cacheKey}`);
  }
  if (!record.smoke?.passed) throw new Error(`Trusted capability cache lacks passing smoke evidence: ${cacheKey}`);
  if (record.security?.overall === "blocked") throw new Error(`Trusted capability cache contains blocked security evidence: ${cacheKey}`);
}

function validateIdentity(identity: CapabilitySourceIdentity): void {
  if (!identity.sourceUri.trim()) throw new Error("Capability cache identity requires sourceUri");
  if (!identity.sourceType.trim()) throw new Error("Capability cache identity requires sourceType");
  if (!identity.resolvedRevision.trim()) throw new Error("Capability cache identity requires resolvedRevision");
  if (!/^sha256:[0-9a-f]{64}$/.test(identity.contentHash)) {
    throw new Error(`Capability cache identity requires sha256 contentHash: ${identity.contentHash}`);
  }
}

function hashBundle(rootInput: string, maxFiles: number, maxBytes: number): string {
  const root = resolve(rootInput);
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error(`Trusted capability bundle root is unsafe: ${root}`);
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];
  let totalBytes = 0;

  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Trusted capability cache rejects symlink: ${path}`);
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Trusted capability cache rejects non-regular file: ${path}`);
      const bytes = readFileSync(path);
      totalBytes += bytes.length;
      if (totalBytes > maxBytes) throw new Error(`Trusted capability cache bundle exceeds ${maxBytes} bytes`);
      files.push({ relativePath: relative(root, path).split(sep).join("/"), bytes });
      if (files.length > maxFiles) throw new Error(`Trusted capability cache bundle exceeds ${maxFiles} files`);
    }
  };
  walk(root);
  if (files.length === 0) throw new Error("Trusted capability cache bundle is empty");

  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.relativePath, "utf8");
    hash.update("\0");
    hash.update(file.bytes);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}
