import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SideEffectRecord } from "../../core/domain/execution.ts";
import type { InvocationRoute } from "../../core/domain/invocation.ts";
import { parseWorkerOutput, WORKER_RECOVERY_FILE, type WorkerOutputEnvelope } from "../../core/execution/worker-output.ts";

export const EXECUTION_RECOVERY_MANIFEST = ".mission-execution-result.json";

export interface ExecutionRecoveryManifest {
  schemaVersion: 1;
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  route: InvocationRoute;
  routeReason: string;
  capabilityRefs: string[];
  targetRef?: string;
  approvalRef?: string;
  result: "succeeded" | "failed" | "partial" | "cancelled" | "timed_out" | "lost";
  sideEffects: SideEffectRecord[];
  envelope: WorkerOutputEnvelope | null;
  startedAt: string;
  endedAt: string;
  writtenAt: string;
}

export function writeExecutionRecoveryManifest(workspaceRoot: string, manifest: ExecutionRecoveryManifest): void {
  const target = join(workspaceRoot, EXECUTION_RECOVERY_MANIFEST);
  const temporary = `${target}.tmp`;
  writeFileSync(temporary, JSON.stringify(manifest, null, 2), "utf8");
  renameSync(temporary, target);
}

export function readExecutionRecoveryManifest(workspaceRoot: string): ExecutionRecoveryManifest | null {
  const path = join(workspaceRoot, EXECUTION_RECOVERY_MANIFEST);
  if (!existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ExecutionRecoveryManifest;
    if (value?.schemaVersion !== 1 || typeof value.executionId !== "string" || typeof value.attemptId !== "string") return null;
    return value;
  } catch { return null; }
}

export function readWorkerRecoveryEnvelope(workspaceRoot: string): WorkerOutputEnvelope | null {
  const path = join(workspaceRoot, WORKER_RECOVERY_FILE);
  if (!existsSync(path)) return null;
  try { return parseWorkerOutput(readFileSync(path, "utf8")); }
  catch { return null; }
}
