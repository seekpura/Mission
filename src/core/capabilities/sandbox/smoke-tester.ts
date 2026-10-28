import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { MaterializedCapabilityCandidate, SandboxAssessment } from "../../domain/capability.ts";
import { SandboxManager } from "./sandbox-manager.ts";

export interface ExecutableSmokeSandbox {
  run(input: { root: string; command: string; args: string[]; timeoutMs: number }): Promise<{ ok: boolean; observation: string }>;
}

export class CapabilitySmokeTester {
  private readonly sandboxes: SandboxManager;
  private readonly executable?: ExecutableSmokeSandbox;

  constructor(sandboxes: SandboxManager, executable?: ExecutableSmokeSandbox) {
    this.sandboxes = sandboxes;
    this.executable = executable;
  }

  async test(materialized: MaterializedCapabilityCandidate): Promise<SandboxAssessment> {
    const sandbox = this.sandboxes.createFromDirectory(materialized.root);
    try {
      const skill = findFile(sandbox.candidateRoot, "SKILL.md", 5);
      if (skill) {
        const body = readFileSync(skill, "utf8").trim();
        if (!body) return failure(materialized, "instruction", "SKILL.md is empty");
        return {
          candidateId: materialized.candidate.id,
          passed: true,
          mode: "instruction",
          observations: ["SKILL.md exists and is non-empty", "No repository executable was run during skill smoke test"],
          invocationRef: skill
        };
      }

      const packageJson = join(sandbox.candidateRoot, "package.json");
      if (existsSync(packageJson)) {
        const pkg = JSON.parse(readFileSync(packageJson, "utf8"));
        const bin = firstBin(pkg.bin);
        if (bin) {
          const target = join(sandbox.candidateRoot, bin);
          if (!existsSync(target)) return failure(materialized, "node-cli", `package.json bin target does not exist: ${bin}`);
          if (!this.executable) {
            return failure(materialized, "node-cli", "Executable candidate requires a configured strong-isolation smoke backend");
          }
          const result = await this.executable.run({ root: sandbox.candidateRoot, command: process.execPath, args: [target, "--help"], timeoutMs: 15_000 });
          return {
            candidateId: materialized.candidate.id,
            passed: result.ok,
            mode: "node-cli",
            observations: [result.observation],
            invocationRef: target,
            ...(result.ok ? {} : { error: "CLI smoke execution failed" })
          };
        }
      }
      return failure(materialized, "generic", "No supported safe smoke strategy found for candidate");
    } finally {
      this.sandboxes.destroy(sandbox);
    }
  }
}

function failure(materialized: MaterializedCapabilityCandidate, mode: SandboxAssessment["mode"], error: string): SandboxAssessment {
  return { candidateId: materialized.candidate.id, passed: false, mode, observations: [], error };
}

function firstBin(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const first = Object.values(value as Record<string, unknown>).find(v => typeof v === "string");
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

function findFile(root: string, name: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return path;
    if (entry.isDirectory()) {
      const found = findFile(path, name, depth - 1);
      if (found) return found;
    }
  }
  return undefined;
}
