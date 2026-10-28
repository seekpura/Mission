import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ArtifactType } from "../../core/domain/artifact.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";
import { WORKER_RECOVERY_FILE } from "../../core/execution/worker-output.ts";
import type { WorkspaceManager } from "../../execution/workspace/workspace-manager.ts";
import { EXECUTION_RECOVERY_MANIFEST, readExecutionRecoveryManifest, readWorkerRecoveryEnvelope, type ExecutionRecoveryManifest } from "./recovery-manifest.ts";

export type RecoveryObservation =
  | { kind: "recoverable"; workspaceRoot: string; envelope: WorkerOutputEnvelope; manifest: ExecutionRecoveryManifest | null; source: "execution-manifest" | "worker-envelope" | "expected-paths" }
  | { kind: "partial"; workspaceRoot: string; files: string[]; manifest: ExecutionRecoveryManifest | null; reason: string }
  | { kind: "none"; reason: string };

export class RecoveryObservationInspector {
  private readonly workspaces: WorkspaceManager;
  constructor(workspaces: WorkspaceManager) { this.workspaces = workspaces; }

  inspect(work: WorkItem, attemptId: string, executionId: string): RecoveryObservation {
    const workspace = this.workspaces.locate(work.missionId, attemptId);
    if (!workspace) return { kind: "none", reason: "Attempt workspace no longer exists" };
    const manifest = readExecutionRecoveryManifest(workspace.root);
    if (manifest && manifest.executionId === executionId && manifest.result === "succeeded") {
      const envelope = manifest.envelope ?? readWorkerRecoveryEnvelope(workspace.root) ?? this.synthesizeExpectedEnvelope(work, workspace.root);
      if (envelope && envelope.status !== "failed") return { kind: "recoverable", workspaceRoot: workspace.root, envelope, manifest, source: "execution-manifest" };
    }
    const workerEnvelope = readWorkerRecoveryEnvelope(workspace.root);
    if (workerEnvelope && workerEnvelope.status !== "failed") return { kind: "recoverable", workspaceRoot: workspace.root, envelope: workerEnvelope, manifest, source: "worker-envelope" };
    const expected = this.synthesizeExpectedEnvelope(work, workspace.root);
    if (expected) return { kind: "recoverable", workspaceRoot: workspace.root, envelope: expected, manifest, source: "expected-paths" };
    const files = this.listMeaningfulFiles(workspace.root);
    if (files.length > 0 || (manifest?.sideEffects.length ?? 0) > 0) {
      return { kind: "partial", workspaceRoot: workspace.root, files, manifest, reason: files.length > 0 ? "Workspace contains unverified partial outputs" : "Execution recorded side effects without recoverable output evidence" };
    }
    return { kind: "none", reason: "No recoverable output evidence was found in the attempt workspace" };
  }

  private synthesizeExpectedEnvelope(work: WorkItem, workspaceRoot: string): WorkerOutputEnvelope | null {
    const declared = work.expectedOutputs.filter(output => typeof output.path === "string" && output.path.length > 0);
    if (declared.length === 0) {
      if (work.expectedOutputs.length === 0) return { status: "completed", summary: "Recovered completed non-artifact work", outputs: [], proposedFacts: [], proposedWork: [], warnings: [] };
      return null;
    }
    if (declared.some(output => output.required && !existsSync(join(workspaceRoot, output.path!)))) return null;
    const existing = declared.filter(output => existsSync(join(workspaceRoot, output.path!)));
    if (existing.length === 0) return null;
    return {
      status: "completed",
      summary: "Recovered outputs from declared artifact paths",
      outputs: existing.map(output => ({ path: output.path!, logicalName: output.logicalName, type: artifactType(output.type), requirementRefs: [] })),
      proposedFacts: [], proposedWork: [], warnings: []
    };
  }

  private listMeaningfulFiles(root: string): string[] {
    const output: string[] = [];
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) { visit(absolute); continue; }
        if (!entry.isFile()) continue;
        const rel = relative(root, absolute);
        if ([EXECUTION_RECOVERY_MANIFEST, WORKER_RECOVERY_FILE].includes(rel)) continue;
        if (statSync(absolute).size > 0) output.push(rel);
      }
    };
    visit(root);
    return output.sort();
  }
}

function artifactType(value: string): ArtifactType {
  const allowed: ArtifactType[] = ["file", "document", "presentation", "image", "video", "audio", "code", "website", "dataset", "research", "other"];
  return allowed.includes(value as ArtifactType) ? value as ArtifactType : "file";
}
