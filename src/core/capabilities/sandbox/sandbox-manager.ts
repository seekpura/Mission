import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface SandboxHandle {
  id: string;
  root: string;
  candidateRoot: string;
}

export class SandboxManager {
  private readonly root: string;
  constructor(root: string) { this.root = root; mkdirSync(root, { recursive: true }); }

  createFromDirectory(source: string): SandboxHandle {
    const id = randomUUID();
    const root = join(this.root, id);
    const candidateRoot = join(root, "candidate");
    mkdirSync(root, { recursive: true });
    cpSync(source, candidateRoot, { recursive: true, dereference: false });
    return { id, root, candidateRoot };
  }

  destroy(handle: SandboxHandle) { rmSync(handle.root, { recursive: true, force: true }); }
}
