import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionRequest, ExecutionResult } from "../../core/domain/execution.ts";
import { WorkspaceManager, type WorkspaceHandle } from "../workspace/workspace-manager.ts";
import { FileArtifactStore } from "../artifacts/artifact-store.ts";
import { ProcessManager } from "./process-manager.ts";

export interface LocalCommandExecutionRequest extends ExecutionRequest {
  localCommand: { command: string; args: string[] };
  outputFiles: Array<{ path: string; logicalName: string; type: any }>;
}

export interface ExecutionHandle {
  id: string;
  request: LocalCommandExecutionRequest;
  workspace: WorkspaceHandle;
}

export class LocalExecutionBackend {
  private readonly active = new Map<string, Promise<ExecutionResult>>();
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly processes: ProcessManager;

  constructor(workspaces: WorkspaceManager, artifacts: FileArtifactStore, processes = new ProcessManager()) {
    this.workspaces = workspaces;
    this.artifacts = artifacts;
    this.processes = processes;
  }

  async allocate(request: LocalCommandExecutionRequest): Promise<ExecutionHandle> {
    return { id: request.executionId, request, workspace: this.workspaces.allocate(request.missionId, request.attemptId) };
  }

  async start(handle: ExecutionHandle): Promise<void> {
    if (this.active.has(handle.id)) throw new Error(`Execution already active: ${handle.id}`);
    this.active.set(handle.id, this.run(handle));
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    const promise = this.active.get(handle.id);
    if (!promise) throw new Error(`Execution not started: ${handle.id}`);
    const result = await promise;
    this.active.delete(handle.id);
    return result;
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    if (!this.active.has(handle.id)) return;
    await this.processes.cancel(handle.id);
  }

  async recover(executionId: string): Promise<"running" | "lost"> {
    return this.active.has(executionId) ? "running" : "lost";
  }

  private async run(handle: ExecutionHandle): Promise<ExecutionResult> {
    const r = handle.request;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const key of r.permissionEnvelope.allowedEnvKeys) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    const run = await this.processes.run({
      executionId: r.executionId,
      command: r.localCommand.command,
      args: r.localCommand.args,
      cwd: handle.workspace.root,
      env,
      timeoutMs: r.timeoutPolicy.hardTimeoutMs
    });
    const committedArtifactRefs: string[] = [];
    const producedFiles: Array<{ path: string; logicalName?: string; type?: string }> = [];
    if (!run.timedOut && run.exitCode === 0) {
      for (const output of r.outputFiles) {
        const source = join(handle.workspace.root, output.path);
        if (!existsSync(source)) continue;
        producedFiles.push({ path: source, logicalName: output.logicalName, type: output.type });
        const artifact = this.artifacts.commit({
          missionId: r.missionId,
          logicalName: output.logicalName,
          type: output.type,
          sourcePath: source,
          producedByAttemptId: r.attemptId
        });
        committedArtifactRefs.push(`${artifact.id}@${artifact.version}`);
      }
    }
    const logPath = join(handle.workspace.root, "execution.log");
    writeFileSync(logPath, `STDOUT\n${run.stdout}\n\nSTDERR\n${run.stderr}`, "utf8");
    return {
      executionId: r.executionId,
      state: run.cancelled ? "cancelled" : run.timedOut ? "timed_out" : run.exitCode === 0 ? "succeeded" : "failed",
      exitCode: run.exitCode ?? undefined,
      producedFiles,
      committedArtifactRefs,
      runtimeObservationRef: run.stdout.trim() || undefined,
      logRef: logPath,
      sideEffects: [],
      startedAt: run.startedAt,
      endedAt: run.endedAt
    };
  }
}
