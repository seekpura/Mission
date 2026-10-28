import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Artifact, ArtifactType } from "../../core/domain/artifact.ts";
import type { ExecutionRequest, ExecutionResult } from "../../core/domain/execution.ts";
import { WorkspaceManager, type WorkspaceHandle } from "../workspace/workspace-manager.ts";
import { FileArtifactStore } from "../artifacts/artifact-store.ts";
import { ProcessManager } from "./process-manager.ts";

export interface LocalCommandExecutionRequest extends ExecutionRequest {
  localCommand: { command: string; args: string[] };
  outputFiles: Array<{ path: string; logicalName: string; type: ArtifactType }>;
}

export interface ExecutionHandle {
  id: string;
  request: LocalCommandExecutionRequest;
  workspace: WorkspaceHandle;
}

export interface LocalExecutionOutcome {
  result: ExecutionResult;
  artifacts: Artifact[];
}

export class LocalExecutionBackend {
  private readonly active = new Map<string, Promise<LocalExecutionOutcome>>();
  private readonly workspaces: WorkspaceManager;
  private readonly artifacts: FileArtifactStore;
  private readonly processes: ProcessManager;

  constructor(workspaces: WorkspaceManager, artifacts: FileArtifactStore, processes = new ProcessManager()) {
    this.workspaces = workspaces;
    this.artifacts = artifacts;
    this.processes = processes;
  }

  async allocate(request: LocalCommandExecutionRequest): Promise<ExecutionHandle> {
    return {
      id: request.executionId,
      request,
      workspace: this.workspaces.allocate(request.missionId, request.attemptId)
    };
  }

  async start(handle: ExecutionHandle): Promise<void> {
    if (this.active.has(handle.id)) throw new Error(`Execution already active: ${handle.id}`);
    this.active.set(handle.id, this.run(handle));
  }

  async collect(handle: ExecutionHandle): Promise<ExecutionResult> {
    return (await this.takeOutcome(handle)).result;
  }

  async collectOutcome(handle: ExecutionHandle): Promise<LocalExecutionOutcome> {
    return this.takeOutcome(handle);
  }

  async cancel(handle: ExecutionHandle): Promise<void> {
    if (!this.active.has(handle.id)) return;
  }

  async recover(executionId: string): Promise<"running" | "lost"> {
    return this.active.has(executionId) ? "running" : "lost";
  }

  private async takeOutcome(handle: ExecutionHandle): Promise<LocalExecutionOutcome> {
    const promise = this.active.get(handle.id);
    if (!promise) throw new Error(`Execution not started: ${handle.id}`);
    try {
      return await promise;
    } finally {
      this.active.delete(handle.id);
    }
  }

  private async run(handle: ExecutionHandle): Promise<LocalExecutionOutcome> {
    const r = handle.request;
    const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
    for (const key of r.permissionEnvelope.allowedEnvKeys) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }

    const run = await this.processes.run({
      command: r.localCommand.command,
      args: r.localCommand.args,
      cwd: handle.workspace.root,
      env,
      timeoutMs: r.timeoutPolicy.hardTimeoutMs
    });

    const committed: Artifact[] = [];
    const producedFiles: Array<{ path: string; logicalName?: string; type?: string }> = [];
    if (!run.timedOut && run.exitCode === 0) {
      for (const output of r.outputFiles) {
        const source = secureWorkspaceFile(handle.workspace.root, output.path);
        if (!existsSync(source)) continue;

        const artifact = this.artifacts.commit({
          missionId: r.missionId,
          logicalName: output.logicalName,
          type: output.type,
          sourcePath: source,
          producedByAttemptId: r.attemptId,
          sourceArtifactRefs: [...r.inputArtifactRefs]
        });
        committed.push(artifact);
        producedFiles.push({
          path: source,
          logicalName: output.logicalName,
          type: output.type
        });
      }
    }

    const logPath = resolve(handle.workspace.root, "execution.log");
    writeFileSync(logPath, `STDOUT\n${run.stdout}\n\nSTDERR\n${run.stderr}`, "utf8");

    return {
      result: {
        executionId: r.executionId,
        state: run.timedOut ? "timed_out" : run.exitCode === 0 ? "succeeded" : "failed",
        exitCode: run.exitCode ?? undefined,
        producedFiles,
        committedArtifactRefs: committed.map(artifact => `${artifact.id}@${artifact.version}`),
        logRef: logPath,
        sideEffects: [],
        startedAt: run.startedAt,
        endedAt: run.endedAt
      },
      artifacts: committed
    };
  }
}

function secureWorkspaceFile(workspaceRoot: string, declaredPath: string): string {
  if (isAbsolute(declaredPath)) {
    throw new Error(`Local output path must be relative: ${declaredPath}`);
  }

  const lexicalRoot = resolve(workspaceRoot);
  const lexical = resolve(lexicalRoot, declaredPath);
  assertWithin(lexicalRoot, lexical, declaredPath);
  if (!existsSync(lexical)) return lexical;

  const realRoot = realpathSync(lexicalRoot);
  const realCandidate = realpathSync(lexical);
  assertWithin(realRoot, realCandidate, declaredPath);
  return realCandidate;
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(root, candidate);
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Local output path escapes workspace: ${label}`);
  }
}
