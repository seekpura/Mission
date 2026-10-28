import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { CapabilityCandidate, CapabilityNeed } from "../core/domain/capability.ts";
import type {
  CapabilitySmokePlan,
  CapabilitySmokePlanResolver,
  IsolatedSmokeExecutor,
  SmokeExecutionResult
} from "../core/capabilities/sandbox/isolated-smoke-runner.ts";
import { SpawnCommandRunner, type CommandRunner } from "./git-repository-snapshot-client.ts";

export interface DockerCapabilitySmokeExecutorOptions {
  dockerBinary?: string;
  image?: string;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  runner?: CommandRunner;
}

export class DockerCapabilitySmokeExecutor implements IsolatedSmokeExecutor {
  readonly id = "docker-capability-smoke";
  readonly isolationLevel = "container" as const;
  private readonly dockerBinary: string;
  private readonly image: string;
  private readonly memoryMb: number;
  private readonly cpus: number;
  private readonly pidsLimit: number;
  private readonly runner: CommandRunner;

  constructor(options: DockerCapabilitySmokeExecutorOptions = {}) {
    this.dockerBinary = options.dockerBinary?.trim() || "docker";
    this.image = options.image?.trim() || "node:22-alpine";
    this.memoryMb = Math.max(64, Math.trunc(options.memoryMb ?? 512));
    this.cpus = Math.max(0.1, options.cpus ?? 1);
    this.pidsLimit = Math.max(16, Math.trunc(options.pidsLimit ?? 128));
    this.runner = options.runner ?? new SpawnCommandRunner();
  }

  async execute(input: {
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
    env: Record<string, string>;
  }): Promise<SmokeExecutionResult> {
    const workspace = resolve(input.cwd);
    const name = `mission-smoke-${randomUUID().replace(/-/g, "").slice(0, 20)}`;
    const timeoutMs = Math.max(1_000, input.timeoutMs ?? 60_000);
    const args = [
      "run",
      "--name", name,
      "--rm",
      "--pull=missing",
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--pids-limit", String(this.pidsLimit),
      "--memory", `${this.memoryMb}m`,
      "--cpus", String(this.cpus),
      "--user", "65534:65534",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--volume", `${workspace}:/workspace:ro`,
      "--workdir", "/workspace",
      ...envArgs(input.env),
      this.image,
      input.command,
      ...input.args
    ];

    let result;
    try {
      result = await this.runner.run(this.dockerBinary, args, { timeoutMs });
    } catch (error) {
      return {
        exitCode: null,
        timedOut: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error)
      };
    }

    if (result.timedOut) {
      try {
        await this.runner.run(this.dockerBinary, ["rm", "-f", name], { timeoutMs: 10_000 });
      } catch {
        // Preserve the smoke timeout as the primary result. Docker --rm still
        // cleans the container when the daemon eventually observes termination.
      }
    }
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      stdout: result.stdout,
      stderr: result.stderr
    };
  }
}

export class AgentSkillSmokePlanResolver implements CapabilitySmokePlanResolver {
  async resolve(input: {
    candidate: CapabilityCandidate;
    need: CapabilityNeed;
    sandboxRoot: string;
  }): Promise<CapabilitySmokePlan> {
    if (input.candidate.candidateKind !== "skill") {
      throw new Error(
        `Automatic external acquisition currently supports Agent Skill delivery only; ` +
        `candidate ${input.candidate.name} is ${input.candidate.candidateKind}`
      );
    }

    const manifest = resolve(input.sandboxRoot, "SKILL.md");
    if (!existsSync(manifest) || !statSync(manifest).isFile()) {
      throw new Error(`Agent Skill candidate must expose SKILL.md at repository root: ${input.candidate.name}`);
    }
    const info = statSync(manifest);
    if (info.size <= 0 || info.size > 512 * 1024) {
      throw new Error(`Agent Skill SKILL.md must be non-empty and <= 512 KiB: ${input.candidate.name}`);
    }
    const text = readFileSync(manifest, "utf8");
    const metadata = parseSkillFrontmatter(text);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name)) {
      throw new Error(`Agent Skill name must be kebab-case: ${metadata.name}`);
    }
    if (!metadata.description.trim()) throw new Error("Agent Skill frontmatter requires description");

    return {
      command: "/bin/sh",
      args: [
        "-lc",
        "test -s SKILL.md && grep -q '^name:' SKILL.md && grep -q '^description:' SKILL.md"
      ],
      timeoutMs: 30_000,
      env: {}
    };
  }
}

export interface ParsedSkillFrontmatter {
  name: string;
  description: string;
}

export function parseSkillFrontmatter(text: string): ParsedSkillFrontmatter {
  const normalized = text.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("Agent Skill SKILL.md must begin with YAML frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("Agent Skill SKILL.md frontmatter is not terminated");
  const frontmatter = lines.slice(1, end);
  const nameLine = frontmatter.find(line => /^name\s*:/.test(line.trim()));
  const descriptionLine = frontmatter.find(line => /^description\s*:/.test(line.trim()));
  if (!nameLine) throw new Error("Agent Skill frontmatter requires name");
  if (!descriptionLine) throw new Error("Agent Skill frontmatter requires description");
  return {
    name: scalarAfterColon(nameLine),
    description: scalarAfterColon(descriptionLine)
  };
}

function scalarAfterColon(line: string): string {
  const value = line.slice(line.indexOf(":") + 1).trim();
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function envArgs(env: Record<string, string>): string[] {
  const output: string[] = [];
  for (const [key, value] of Object.entries(env).sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Unsafe smoke environment variable name: ${key}`);
    output.push("--env", `${key}=${value}`);
  }
  return output;
}
