import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { CapabilityDescriptor, CapabilityNeed, CapabilityCandidate } from "../core/domain/capability.ts";
import type { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
import type {
  CapabilitySmokePlan,
  CapabilitySmokePlanResolver,
  IsolatedSmokeExecutor,
  SmokeExecutionResult
} from "../core/capabilities/sandbox/isolated-smoke-runner.ts";

export interface DockerSmokeExecutorOptions {
  image: string;
  binary?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

export class DockerSmokeExecutor implements IsolatedSmokeExecutor {
  readonly id = "docker-capability-smoke";
  readonly isolationLevel = "container" as const;
  private readonly image: string;
  private readonly binary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;

  constructor(options: DockerSmokeExecutorOptions) {
    if (!options.image.trim()) throw new Error("Docker capability smoke requires an explicit image");
    this.image = options.image.trim();
    this.binary = options.binary?.trim() || "docker";
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30_000);
    this.maxOutputBytes = Math.max(1_024, options.maxOutputBytes ?? 64 * 1_024);
    this.memory = options.memory?.trim() || "256m";
    this.cpus = options.cpus?.trim() || "0.5";
    this.pidsLimit = Math.max(16, options.pidsLimit ?? 64);
  }

  async execute(input: {
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
    env: Record<string, string>;
  }): Promise<SmokeExecutionResult> {
    const cwd = resolve(input.cwd);
    if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Invalid capability smoke directory: ${cwd}`);
    if (!input.command.trim()) throw new Error("Capability smoke command is empty");
    const name = `mission-smoke-${randomUUID().replaceAll("-", "")}`;
    const args = [
      "run", "--rm", "--pull=never", "--name", name,
      "--network=none",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      `--pids-limit=${this.pidsLimit}`,
      `--memory=${this.memory}`,
      `--cpus=${this.cpus}`,
      "--user", "65534:65534",
      "--volume", `${cwd}:/workspace:ro`,
      "--workdir", "/workspace",
      "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=32m"
    ];
    for (const [key, value] of Object.entries(input.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) {
        throw new Error(`Invalid capability smoke environment entry: ${key}`);
      }
      args.push("--env", `${key}=${value}`);
    }
    args.push(this.image, input.command, ...input.args);

    const timeoutMs = Math.max(1_000, input.timeoutMs ?? this.timeoutMs);
    return new Promise<SmokeExecutionResult>((resolveResult, reject) => {
      const child = spawn(this.binary, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;

      child.stdout.on("data", chunk => { stdout = appendBounded(stdout, Buffer.from(chunk), this.maxOutputBytes); });
      child.stderr.on("data", chunk => { stderr = appendBounded(stderr, Buffer.from(chunk), this.maxOutputBytes); });
      child.once("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", code => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolveResult({
          exitCode: code,
          timedOut,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
      });

      const timer = setTimeout(() => {
        if (settled) return;
        timedOut = true;
        child.kill("SIGKILL");
        void removeContainer(this.binary, name);
      }, timeoutMs);
      timer.unref();
    });
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
        `No safe production smoke profile is registered for capability kind ${input.candidate.candidateKind}; only instruction-only Agent Skills are enabled`
      );
    }
    const skills = findSkillFiles(input.sandboxRoot, 2);
    if (skills.length !== 1) {
      throw new Error(`Agent Skill acquisition requires exactly one SKILL.md; found ${skills.length}`);
    }
    return {
      command: "/bin/sh",
      args: [
        "-eu",
        "-c",
        "count=$(find . -name SKILL.md -type f | wc -l); [ \"$count\" -eq 1 ]; skill=$(find . -name SKILL.md -type f -print -quit); [ -s \"$skill\" ]; grep -q '[^[:space:]]' \"$skill\""
      ],
      timeoutMs: 10_000,
      env: {}
    };
  }
}

export interface AgentSkillExecutionContext {
  id: string;
  name: string;
  revision?: string;
  contentHash: string;
  instructions: string;
}

export class MissionAgentSkillContextResolver {
  private readonly overlay: MissionCapabilityOverlay;
  private readonly maxSkillBytes: number;

  constructor(overlay: MissionCapabilityOverlay, options: { maxSkillBytes?: number } = {}) {
    this.overlay = overlay;
    this.maxSkillBytes = Math.max(1_024, options.maxSkillBytes ?? 128 * 1_024);
  }

  resolve(missionId: string, capabilityRefs: string[]): AgentSkillExecutionContext[] {
    const byId = new Map(this.overlay.list(missionId).map(capability => [capability.id, capability]));
    const contexts: AgentSkillExecutionContext[] = [];
    for (const ref of [...new Set(capabilityRefs)]) {
      const capability = byId.get(ref);
      if (!capability) continue;
      if (capability.hostNative) continue;
      if (capability.kind !== "skill") {
        throw new Error(`Mission-local capability ${ref} is not deliverable as instruction context: ${capability.kind}`);
      }
      contexts.push(readSkillContext(capability, this.maxSkillBytes));
    }
    return contexts;
  }
}

function readSkillContext(capability: CapabilityDescriptor, maxSkillBytes: number): AgentSkillExecutionContext {
  if (!capability.invocationRef) throw new Error(`Mission-local Agent Skill has no activation directory: ${capability.id}`);
  const files = findSkillFiles(capability.invocationRef, 2);
  if (files.length !== 1) {
    throw new Error(`Activated Agent Skill ${capability.id} requires exactly one SKILL.md; found ${files.length}`);
  }
  const path = files[0]!;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Activated SKILL.md must be a regular file: ${path}`);
  if (stat.size <= 0 || stat.size > maxSkillBytes) {
    throw new Error(`Activated SKILL.md size ${stat.size} is outside allowed range 1..${maxSkillBytes}`);
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) throw new Error(`Activated SKILL.md contains NUL bytes: ${path}`);
  const instructions = bytes.toString("utf8");
  if (!instructions.trim()) throw new Error(`Activated SKILL.md is empty: ${path}`);
  return {
    id: capability.id,
    name: capability.name,
    ...(capability.revision ? { revision: capability.revision } : {}),
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    instructions
  };
}

function findSkillFiles(root: string, limit: number): string[] {
  const result: string[] = [];
  const rootResolved = resolve(root);
  walk(rootResolved, 0);
  return result;

  function walk(current: string, depth: number): void {
    if (result.length >= limit || depth > 12) return;
    const entries = readdirSync(current, { withFileTypes: true })
      .filter(entry => entry.name !== ".git")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (result.length >= limit) return;
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name === "SKILL.md") result.push(path);
    }
  }
}

function appendBounded(current: Buffer, incoming: Buffer, maxBytes: number): Buffer {
  if (incoming.length >= maxBytes) return incoming.subarray(incoming.length - maxBytes);
  if (current.length + incoming.length <= maxBytes) return Buffer.concat([current, incoming]);
  const keep = maxBytes - incoming.length;
  return Buffer.concat([current.subarray(current.length - keep), incoming]);
}

async function removeContainer(binary: string, name: string): Promise<void> {
  await new Promise<void>(resolveDone => {
    const child = spawn(binary, ["rm", "-f", name], { stdio: "ignore", env: process.env });
    child.once("error", () => resolveDone());
    child.once("close", () => resolveDone());
  });
}
