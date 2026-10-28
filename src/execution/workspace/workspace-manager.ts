import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export interface WorkspaceHandle {
  id: string;
  missionId: string;
  attemptId: string;
  root: string;
}

export class WorkspaceManager {
  private readonly root: string;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true });
  }

  pathFor(missionId: string, attemptId: string): string {
    return join(this.root, missionId, "working", attemptId);
  }

  allocate(missionId: string, attemptId: string): WorkspaceHandle {
    const path = this.pathFor(missionId, attemptId);
    mkdirSync(path, { recursive: true });
    return { id: `${missionId}:${attemptId}`, missionId, attemptId, root: path };
  }

  openExisting(missionId: string, attemptId: string): WorkspaceHandle {
    const path = this.pathFor(missionId, attemptId);
    if (!existsSync(path) || !statSync(path).isDirectory()) {
      throw new Error(`Attempt workspace is unavailable for recovery: ${path}`);
    }
    return { id: `${missionId}:${attemptId}`, missionId, attemptId, root: path };
  }

  cleanup(handle: WorkspaceHandle) {
    rmSync(handle.root, { recursive: true, force: true });
  }
}
