import { existsSync, mkdirSync, rmSync } from "node:fs";
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

  allocate(missionId: string, attemptId: string): WorkspaceHandle {
    const path = join(this.root, missionId, "working", attemptId);
    mkdirSync(path, { recursive: true });
    return { id: `${missionId}:${attemptId}`, missionId, attemptId, root: path };
  }

  locate(missionId: string, attemptId: string): WorkspaceHandle | null {
    const path = join(this.root, missionId, "working", attemptId);
    return existsSync(path) ? { id: `${missionId}:${attemptId}`, missionId, attemptId, root: path } : null;
  }

  cleanup(handle: WorkspaceHandle) {
    rmSync(handle.root, { recursive: true, force: true });
  }
}
