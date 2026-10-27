import { spawn } from "node:child_process";

export interface ProcessSpec {
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
  startedAt: string;
  endedAt: string;
}

export class ProcessManager {
  async run(spec: ProcessSpec): Promise<ProcessRunResult> {
    const startedAt = new Date().toISOString();
    return new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", d => { stdout += d; });
      child.stderr.on("data", d => { stderr += d; });
      const timer = spec.timeoutMs ? setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1000).unref();
      }, spec.timeoutMs) : undefined;
      timer?.unref();
      child.on("error", reject);
      child.on("close", code => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr, timedOut, startedAt, endedAt: new Date().toISOString() });
      });
    });
  }
}
