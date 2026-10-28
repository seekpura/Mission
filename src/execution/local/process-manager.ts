import { spawn } from "node:child_process";

export interface ProcessSpec {
  executionId?: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
}

export interface ProcessRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  startedAt: string;
  endedAt: string;
}

export class ProcessManager {
  private readonly active = new Map<string, ReturnType<typeof spawn>>();
  private readonly cancelled = new Set<string>();

  async run(spec: ProcessSpec): Promise<ProcessRunResult> {
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32"
      });
      if (spec.executionId) this.active.set(spec.executionId, child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", d => { stdout += d; });
      child.stderr?.on("data", d => { stderr += d; });
      const timer = spec.timeoutMs ? setTimeout(() => {
        timedOut = true;
        this.terminate(child, "SIGTERM");
        setTimeout(() => this.terminate(child, "SIGKILL"), 1000).unref();
      }, spec.timeoutMs) : undefined;
      timer?.unref();
      child.on("error", error => {
        if (spec.executionId) this.active.delete(spec.executionId);
        reject(error);
      });
      child.on("close", code => {
        if (timer) clearTimeout(timer);
        const cancelled = spec.executionId ? this.cancelled.delete(spec.executionId) : false;
        if (spec.executionId) this.active.delete(spec.executionId);
        resolve({ exitCode: code, stdout, stderr, timedOut, cancelled, startedAt, endedAt: new Date().toISOString() });
      });
    });
  }

  async cancel(executionId: string): Promise<boolean> {
    const child = this.active.get(executionId);
    if (!child) return false;
    this.cancelled.add(executionId);
    this.terminate(child, "SIGTERM");
    setTimeout(() => {
      if (this.active.has(executionId)) this.terminate(child, "SIGKILL");
    }, 1000).unref();
    return true;
  }

  isActive(executionId: string): boolean { return this.active.has(executionId); }

  private terminate(child: ReturnType<typeof spawn>, signal: NodeJS.Signals): void {
    if (process.platform !== "win32" && child.pid) {
      try { process.kill(-child.pid, signal); return; } catch {}
    }
    try { child.kill(signal); } catch {}
  }
}
