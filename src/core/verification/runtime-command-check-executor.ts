import { dirname } from "node:path";
import type { Artifact } from "../domain/artifact.ts";
import type { VerificationCheck, VerificationCheckResult } from "../domain/verification.ts";
import type { VerificationCheckExecutor, VerificationCheckExecutorContext } from "./check-executor.ts";
import { ProcessManager } from "../../execution/local/process-manager.ts";

export class RuntimeCommandCheckExecutor implements VerificationCheckExecutor {
  id = "runtime-command-checks";
  private readonly processes: ProcessManager;
  constructor(processes = new ProcessManager()) { this.processes = processes; }

  supports(check: VerificationCheck): boolean {
    return check.method === "runtime" && typeof check.config?.runtime?.command === "string" && check.config.runtime.command.length > 0;
  }

  async execute(artifact: Artifact, check: VerificationCheck, _context: VerificationCheckExecutorContext): Promise<VerificationCheckResult> {
    const spec = check.config!.runtime!;
    const cwd = dirname(artifact.uri);
    const args = (spec.args ?? []).map(value => substitute(value, artifact));
    const result = await this.processes.run({
      executionId: `verify:${artifact.missionId}:${artifact.id}:${artifact.version}:${check.id}`,
      command: substitute(spec.command, artifact),
      args,
      cwd,
      env: { PATH: process.env.PATH ?? "", ...(spec.env ?? {}) },
      timeoutMs: clampTimeout(spec.timeoutMs)
    });
    const status: VerificationCheckResult["status"] = result.cancelled || result.timedOut || result.exitCode !== 0 ? "fail" : "pass";
    const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n").slice(-2000);
    const detail = status === "pass"
      ? output || `Runtime validation exited successfully with code ${String(result.exitCode)}`
      : result.timedOut ? "Runtime validation timed out"
        : result.cancelled ? "Runtime validation was cancelled"
          : `Runtime validation exited with code ${String(result.exitCode)}${output ? `: ${output}` : ""}`;
    return checkResult(check, status, detail);
  }
}

function substitute(value: string, artifact: Artifact): string {
  return value.replaceAll("{artifact}", artifact.uri).replaceAll("{artifactDir}", dirname(artifact.uri));
}
function clampTimeout(value?: number): number {
  if (!Number.isFinite(value)) return 30000;
  return Math.max(1000, Math.min(120000, Number(value)));
}
function checkResult(check: VerificationCheck, status: VerificationCheckResult["status"], detail: string): VerificationCheckResult {
  return { id: check.id, status, detail, evidenceRefs: [], method: check.method, priority: check.priority, category: check.category, requirementRefs: check.requirementRefs };
}
