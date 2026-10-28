import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { CapabilityCandidate } from "../domain/capability.ts";

export interface MaterializedCapability {
  candidateId: string;
  sourceType: CapabilityCandidate["sourceType"];
  sourceUri: string;
  root: string;
  resolvedRevision: string;
  contentHash: string;
  materializedAt: string;
}

export interface CapabilityMaterializer {
  materialize(candidate: CapabilityCandidate): Promise<MaterializedCapability>;
  cleanup?(materialized: MaterializedCapability): Promise<void> | void;
}

export interface RepositorySnapshotClient {
  snapshot(input: {
    sourceUri: string;
    targetDirectory: string;
    requestedRevision?: string;
  }): Promise<{ resolvedRevision: string }>;
}

export interface RepositoryMaterializerOptions {
  stagingRoot: string;
  client: RepositorySnapshotClient;
}

/**
 * Materializes a repository snapshot through an injected transport client,
 * then independently computes a deterministic content hash over the checkout.
 * The transport may be a host-native GitHub connector, authenticated git
 * service, or another repository fetcher; provenance does not depend on the
 * transport implementation.
 */
export class RepositoryCapabilityMaterializer implements CapabilityMaterializer {
  private readonly stagingRoot: string;
  private readonly client: RepositorySnapshotClient;

  constructor(options: RepositoryMaterializerOptions) {
    this.stagingRoot = options.stagingRoot;
    this.client = options.client;
  }

  async materialize(candidate: CapabilityCandidate): Promise<MaterializedCapability> {
    if (candidate.sourceType !== "github" && candidate.sourceType !== "agent-skill") {
      throw new Error(`Repository materializer cannot handle source type: ${candidate.sourceType}`);
    }

    const targetDirectory = join(this.stagingRoot, `${safeSegment(candidate.id)}-${randomUUID()}`);
    const snapshot = await this.client.snapshot({
      sourceUri: candidate.sourceUri,
      targetDirectory,
      requestedRevision: candidate.resolvedRevision
    });
    if (!snapshot.resolvedRevision.trim()) {
      throw new Error(`Materializer did not resolve an immutable revision for ${candidate.name}`);
    }

    const root = realpathSync(targetDirectory);
    validateSymlinks(root);
    return {
      candidateId: candidate.id,
      sourceType: candidate.sourceType,
      sourceUri: candidate.sourceUri,
      root,
      resolvedRevision: snapshot.resolvedRevision,
      contentHash: hashDirectory(root),
      materializedAt: new Date().toISOString()
    };
  }
}

export function hashDirectory(root: string): string {
  const rootReal = realpathSync(root);
  const hash = createHash("sha256");
  for (const entry of walkDeterministic(rootReal)) {
    hash.update(entry.type);
    hash.update("\0");
    hash.update(entry.relativePath);
    hash.update("\0");
    if (entry.type === "file") hash.update(readFileSync(entry.absolutePath));
    else hash.update(entry.linkTarget ?? "");
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function validateSymlinks(root: string): void {
  const rootReal = realpathSync(root);
  for (const entry of walkDeterministic(rootReal)) {
    if (entry.type !== "symlink") continue;
    const target = entry.linkTarget ?? "";
    if (isAbsolute(target)) {
      throw new Error(`Capability snapshot contains absolute symlink: ${entry.relativePath}`);
    }
    const resolved = realpathSync(entry.absolutePath);
    assertWithin(rootReal, resolved, entry.relativePath);
  }
}

interface TreeEntry {
  type: "file" | "symlink";
  absolutePath: string;
  relativePath: string;
  linkTarget?: string;
}

function* walkDeterministic(root: string, current = root): Generator<TreeEntry> {
  const entries = readdirSync(current, { withFileTypes: true })
    .filter(entry => entry.name !== ".git")
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const absolutePath = join(current, entry.name);
    const rel = relative(root, absolutePath).split(sep).join("/");
    const stat = lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      yield {
        type: "symlink",
        absolutePath,
        relativePath: rel,
        linkTarget: readlinkSync(absolutePath)
      };
      continue;
    }
    if (stat.isDirectory()) {
      yield* walkDeterministic(root, absolutePath);
      continue;
    }
    if (stat.isFile()) {
      yield { type: "file", absolutePath, relativePath: rel };
    }
  }
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Capability symlink escapes materialized root: ${label}`);
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "candidate";
}
