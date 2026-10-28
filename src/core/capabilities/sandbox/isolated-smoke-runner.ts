import type { CapabilityCandidate, CapabilityNeed } from "../../domain/capability.ts";

export type SmokeIsolationLevel = "host" | "process" | "restricted" | "container" | "vm" | "remote";

export interface CapabilitySmokePlan {
  command: string;
  args: string[];
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface SmokeExecutionResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface IsolatedSmokeExecutor {
  id: string;
  isolationLevel: SmokeIsolationLevel;
  execute(input: {
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
    env: Record<string, string>;
  }): Promise<SmokeExecutionResult>;
}

export interface CapabilitySmokePlanResolver {
  resolve(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    sandboxRoot: string;
  }): Promise<CapabilitySmokePlan>;
}

export interface CapabilitySmokeResult {
  executorId: string;
  isolationLevel: SmokeIsolationLevel;
  command: string;
  args: string[];
  passed: boolean;
  exitCode: number | null;
  timedOut: boolean;
  stdoutTail: string;
  stderrTail: string;
  startedAt: string;
  endedAt: string;
}

export class IsolatedCapabilitySmokeRunner {
  private readonly executor: IsolatedSmokeExecutor;
  private readonly resolver: CapabilitySmokePlanResolver;
  private readonly maxTailBytes: number;

  constructor(
    executor: IsolatedSmokeExecutor,
    resolver: CapabilitySmokePlanResolver,
    options: { maxTailBytes?: number } = {}
  ) {
    this.executor = executor;
    this.resolver = resolver;
    this.maxTailBytes = Math.max(256, options.maxTailBytes ?? 16_384);
  }

  async run(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    sandboxRoot: string;
  }): Promise<CapabilitySmokeResult> {
    if (!isStrongIsolation(this.executor.isolationLevel)) {
      throw new Error(
        `External capability smoke execution requires restricted/container/vm/remote isolation; ` +
        `executor ${this.executor.id} reports ${this.executor.isolationLevel}`
      );
    }

    const plan = await this.resolver.resolve(input);
    if (!plan.command.trim()) throw new Error("Capability smoke plan requires a command");
    if (!Array.isArray(plan.args)) throw new Error("Capability smoke plan args must be an array");

    const startedAt = new Date().toISOString();
    const result = await this.executor.execute({
      cwd: input.sandboxRoot,
      command: plan.command,
      args: [...plan.args],
      timeoutMs: plan.timeoutMs,
      env: { ...(plan.env ?? {}) }
    });
    const endedAt = new Date().toISOString();

    return {
      executorId: this.executor.id,
      isolationLevel: this.executor.isolationLevel,
      command: plan.command,
      args: [...plan.args],
      passed: !result.timedOut && result.exitCode === 0,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdoutTail: tail(result.stdout, this.maxTailBytes),
      stderrTail: tail(result.stderr, this.maxTailBytes),
      startedAt,
      endedAt
    };
  }
}

function isStrongIsolation(level: SmokeIsolationLevel): boolean {
  return level === "restricted" || level === "container" || level === "vm" || level === "remote";
}

function tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
