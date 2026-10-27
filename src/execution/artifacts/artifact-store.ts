import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { Artifact, ArtifactType } from "../../core/domain/artifact.ts";

export interface CommitArtifactInput {
  missionId: string;
  logicalName: string;
  type: ArtifactType;
  sourcePath: string;
  producedByAttemptId: string;
  sourceArtifactRefs?: string[];
  mimeType?: string;
}

export class FileArtifactStore {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  commit(input: CommitArtifactInput): Artifact {
    if (!existsSync(input.sourcePath)) throw new Error(`Artifact source does not exist: ${input.sourcePath}`);
    const current = this.listVersions(input.missionId, input.logicalName);
    const version = current.length + 1;
    const id = input.logicalName;
    const dir = join(this.root, input.missionId, "artifacts", id, String(version).padStart(4, "0"));
    mkdirSync(dir, { recursive: true });
    const suffix = extname(input.sourcePath);
    const target = join(dir, `artifact${suffix || ""}`);
    copyFileSync(input.sourcePath, target);
    const bytes = readFileSync(target);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const artifact: Artifact = {
      id,
      missionId: input.missionId,
      logicalName: input.logicalName,
      type: input.type,
      version,
      status: "candidate",
      uri: target,
      contentHash: hash,
      mimeType: input.mimeType,
      sizeBytes: statSync(target).size,
      producedByAttemptId: input.producedByAttemptId,
      sourceArtifactRefs: input.sourceArtifactRefs ?? [],
      createdAt: new Date().toISOString()
    };
    return artifact;
  }

  listVersions(missionId: string, logicalName: string): number[] {
    const base = join(this.root, missionId, "artifacts", logicalName);
    try {
      return readdirSync(base, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d+$/.test(e.name))
        .map(e => Number(e.name))
        .sort((a, b) => a - b);
    } catch {
      return [];
    }
  }
}
