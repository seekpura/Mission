import { existsSync, readdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { RepositorySnapshotClient } from "../core/capabilities/materialization.ts";

export interface CommandRunResult {
  exitCode: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  }): Promise<CommandRunResult>;
}

export interface GitRepositorySnapshotClientOptions {
  gitBinary?: string;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export class GitRepositorySnapshotClient implements RepositorySnapshotClient {
  private readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(options: GitRepositorySnapshotClientOptions = {}) {
    this.gitBinary = options.gitBinary?.trim() || "git";
    this.timeoutMs = Math.max(5_000, options.timeoutMs ?? 120_000);
    this.runner = options.runner ?? new SpawnCommandRunner();
  }

  async snapshot(input: {
    sourceUri: string;
    targetDirectory: string;
    requestedRevision?: string;
  }): Promise<{ resolvedRevision: string }> {
    const sourceUri = canonicalGitHubCloneUrl(input.sourceUri);
    const targetDirectory = resolve(input.targetDirectory);
    if (!existsSync(targetDirectory)) throw new Error(`Snapshot target directory does not exist: ${targetDirectory}`);
    if (readdirSync(targetDirectory).length > 0) throw new Error(`Snapshot target directory must be empty: ${targetDirectory}`);
    const requestedRevision = input.requestedRevision?.trim();
    if (requestedRevision) validateRevision(requestedRevision);

    const env = safeGitEnv();
    await this.git([
      "-c", hooksConfig(),
      "clone",
      "--no-checkout",
      "--no-tags",
      "--depth=1",
      "--filter=blob:none",
      "--",
      sourceUri,
      targetDirectory
    ], { env });

    if (requestedRevision) {
      await this.git([
        "-c", hooksConfig(),
        "-C", targetDirectory,
        "fetch",
        "--no-tags",
        "--depth=1",
        "origin",
        requestedRevision
      ], { env });
      await this.git([
        "-c", hooksConfig(),
        "-C", targetDirectory,
        "checkout",
        "--detach",
        "--force",
        "FETCH_HEAD"
      ], { env });
    } else {
      await this.git([
        "-c", hooksConfig(),
        "-C", targetDirectory,
        "checkout",
        "--detach",
        "--force",
        "HEAD"
      ], { env });
    }

    const revision = await this.git([
      "-c", hooksConfig(),
      "-C", targetDirectory,
      "rev-parse",
      "--verify",
      "HEAD^{commit}"
    ], { env });
    const resolvedRevision = revision.stdout.trim();
    if (!/^[0-9a-f]{40,64}$/i.test(resolvedRevision)) {
      throw new Error(`Git snapshot did not resolve an immutable commit id: ${resolvedRevision || "empty"}`);
    }

    rmSync(resolve(targetDirectory, ".git"), { recursive: true, force: true });
    return { resolvedRevision };
  }

  private async git(args: string[], options: { env: NodeJS.ProcessEnv }): Promise<CommandRunResult> {
    const result = await this.runner.run(this.gitBinary, args, {
      env: options.env,
      timeoutMs: this.timeoutMs
    });
    if (result.timedOut) throw new Error(`Git command timed out after ${this.timeoutMs}ms`);
    if (result.exitCode !== 0) {
      throw new Error(`Git command failed (${String(result.exitCode)}): ${tail(result.stderr || result.stdout, 8_192)}`);
    }
    return result;
  }
}

export class SpawnCommandRunner implements CommandRunner {
  async run(command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs: number;
  }): Promise<CommandRunResult> {
    return new Promise<CommandRunResult>((resolveResult, reject) => {
      const child = spawn(command, args, {
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: options.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout = tail(`${stdout}${String(chunk)}`, 32_768); });
      child.stderr.on("data", chunk => { stderr = tail(`${stderr}${String(chunk)}`, 32_768); });
      child.once("error", error => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", code => {
        clearTimeout(timer);
        resolveResult({ exitCode: code, timedOut, stdout, stderr });
      });
    });
  }
}

export function canonicalGitHubCloneUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com") {
    throw new Error(`Repository snapshot source must be an HTTPS github.com URL: ${value}`);
  }
  if (url.username || url.password || url.port || url.search || url.hash) {
    throw new Error("Repository snapshot URL must not contain credentials, port, query, or fragment");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error(`Repository snapshot URL must name exactly owner/repository: ${value}`);
  const owner = repoSegment(parts[0]!);
  const repo = repoSegment(parts[1]!.replace(/\.git$/i, ""));
  return `https://github.com/${owner}/${repo}.git`;
}

function repoSegment(value: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Unsafe GitHub repository path segment: ${value}`);
  return value;
}

function validateRevision(value: string): void {
  if (value.startsWith("-") || value.includes("..") || value.length > 200 || !/^[A-Za-z0-9._/@+-]+$/.test(value)) {
    throw new Error(`Unsafe requested repository revision: ${value}`);
  }
}

function hooksConfig(): string {
  return `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`;
}

function safeGitEnv(): NodeJS.ProcessEnv {
  const nullDevice = process.platform === "win32" ? "NUL" : "/dev/null";
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: nullDevice,
    GIT_CONFIG_SYSTEM: nullDevice,
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0"
  };
}

function tail(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8");
}
