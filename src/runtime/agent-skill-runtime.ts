import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import type { CapabilityDescriptor, CapabilityNeed, CapabilityCandidate } from "../core/domain/capability.ts";
import type { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
import type {
  MaterializedActivationInput,
  MaterializedCapabilityActivator
} from "../core/capabilities/mission-local-directory-activator.ts";
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
    inspectCandidateSkillBundle(input.sandboxRoot);
    return {
      command: "/bin/sh",
      args: [
        "-eu",
        "-c",
        "count=$(find . -name SKILL.md -type f | wc -l); [ \"$count\" -eq 1 ]; skill=$(find . -name SKILL.md -type f -print -quit); [ -s \"$skill\" ]; grep -q '^name[[:space:]]*:' \"$skill\"; grep -q '^description[[:space:]]*:' \"$skill\""
      ],
      timeoutMs: 10_000,
      env: {}
    };
  }
}

export interface AgentSkillMissionLocalActivatorOptions {
  maxSkillBytes?: number;
  maxBundleBytes?: number;
  maxBundleFiles?: number;
}

/**
 * Activates only the unique DSH-compatible Agent Skill bundle inside a scanned
 * repository snapshot. The rest of the source repository is deliberately not
 * copied into the runtime capability directory.
 */
export class AgentSkillMissionLocalActivator implements MaterializedCapabilityActivator {
  private readonly root: string;
  private readonly limits: BundleLimits;

  constructor(root: string, options: AgentSkillMissionLocalActivatorOptions = {}) {
    this.root = resolve(root);
    this.limits = bundleLimits(options);
    mkdirSync(this.root, { recursive: true });
  }

  async activate(input: MaterializedActivationInput): Promise<CapabilityDescriptor> {
    if (input.candidate.candidateKind !== "skill") {
      throw new Error(`Agent Skill activator cannot activate ${input.candidate.candidateKind}`);
    }
    const inspected = inspectCandidateSkillBundle(input.sandboxRoot, this.limits);
    const revisionSegment = safeSegment(input.materialized.resolvedRevision || input.materialized.contentHash);
    const destination = join(
      this.root,
      safeSegment(input.need.missionId),
      safeSegment(input.candidate.id),
      revisionSegment
    );
    if (existsSync(destination)) rmSync(destination, { recursive: true, force: true });
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(inspected.bundleRoot, destination, { recursive: true, dereference: false });
    inspectActivatedSkillBundle(destination, this.limits);

    return {
      id: `acquired:${input.candidate.id}`,
      kind: "skill",
      name: inspected.metadata.name,
      description: inspected.metadata.description,
      hostNative: false,
      available: true,
      invocationRef: destination,
      permissions: [...input.security.requestedPermissions],
      revision: input.materialized.resolvedRevision,
      scope: "mission"
    };
  }
}

export interface AgentSkillProjection {
  capabilityId: string;
  skillName: string;
  revision?: string;
  contentHash: string;
  workspacePath: string;
}

export interface MissionAgentSkillWorkspaceProjectorOptions {
  maxSkillBytes?: number;
  maxBundleBytes?: number;
  maxBundleFiles?: number;
}

/**
 * Delivers only the acquired skills authorized for one WorkItem into the
 * attempt-local `.agents/skills` root. DeepSeek Harness then discovers and
 * loads them through its native skill catalog/tool instead of Mission injecting
 * the full instructions into the prompt.
 */
export class MissionAgentSkillWorkspaceProjector {
  private readonly overlay: MissionCapabilityOverlay;
  private readonly limits: BundleLimits;

  constructor(overlay: MissionCapabilityOverlay, options: MissionAgentSkillWorkspaceProjectorOptions = {}) {
    this.overlay = overlay;
    this.limits = bundleLimits(options);
  }

  project(missionId: string, capabilityRefs: string[], workspaceRoot: string): AgentSkillProjection[] {
    const workspace = realDirectory(workspaceRoot, "Mission attempt workspace");
    const agentsRoot = prepareOwnedDirectory(workspace, ".agents");
    const skillsRoot = join(agentsRoot, "skills");
    if (existsSync(skillsRoot)) {
      const info = lstatSync(skillsRoot);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new Error(`Mission skill projection root is not an owned directory: ${skillsRoot}`);
      }
      rmSync(skillsRoot, { recursive: true, force: true });
    }
    mkdirSync(skillsRoot, { recursive: true });

    const byId = new Map(this.overlay.list(missionId).map(capability => [capability.id, capability]));
    const projections: AgentSkillProjection[] = [];
    const skillNames = new Set<string>();

    for (const ref of [...new Set(capabilityRefs)].sort()) {
      const capability = byId.get(ref);
      if (!capability) {
        if (ref.startsWith("acquired:")) throw new Error(`Authorized acquired capability is missing from mission overlay: ${ref}`);
        continue;
      }
      if (capability.hostNative) continue;
      if (capability.kind !== "skill") {
        throw new Error(`No workspace delivery adapter is registered for mission-local capability ${ref} (${capability.kind})`);
      }
      if (!capability.invocationRef) throw new Error(`Mission-local Agent Skill has no activation directory: ${ref}`);

      const inspected = inspectActivatedSkillBundle(capability.invocationRef, this.limits);
      if (skillNames.has(inspected.metadata.name)) {
        throw new Error(`Multiple authorized capabilities project the same Agent Skill name: ${inspected.metadata.name}`);
      }
      skillNames.add(inspected.metadata.name);

      const destination = join(skillsRoot, inspected.metadata.name);
      cpSync(inspected.bundleRoot, destination, { recursive: true, dereference: false });
      const projected = inspectActivatedSkillBundle(destination, this.limits);
      projections.push({
        capabilityId: capability.id,
        skillName: projected.metadata.name,
        ...(capability.revision ? { revision: capability.revision } : {}),
        contentHash: projected.contentHash,
        workspacePath: relative(workspace, join(destination, "SKILL.md")).split(sep).join("/")
      });
    }

    writeFileSync(
      join(workspace, ".mission-skill-projection.json"),
      `${JSON.stringify({ missionId, capabilities: projections }, null, 2)}\n`,
      "utf8"
    );
    return projections;
  }
}

export interface AgentSkillMetadata {
  name: string;
  description: string;
  modelInvocable: boolean;
}

interface InspectedSkillBundle {
  bundleRoot: string;
  skillPath: string;
  metadata: AgentSkillMetadata;
  contentHash: string;
}

interface BundleLimits {
  maxSkillBytes: number;
  maxBundleBytes: number;
  maxBundleFiles: number;
}

function inspectCandidateSkillBundle(root: string, limits: BundleLimits = bundleLimits({})): InspectedSkillBundle {
  const skills = findSkillFiles(root, 2);
  if (skills.length !== 1) {
    throw new Error(`Agent Skill acquisition requires exactly one SKILL.md; found ${skills.length}`);
  }
  return inspectSkillBundle(dirname(skills[0]!), limits);
}

function inspectActivatedSkillBundle(root: string, limits: BundleLimits): InspectedSkillBundle {
  const bundleRoot = realDirectory(root, "Activated Agent Skill bundle");
  const skillPath = join(bundleRoot, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Activated Agent Skill bundle is missing root SKILL.md: ${bundleRoot}`);
  return inspectSkillBundle(bundleRoot, limits);
}

function inspectSkillBundle(bundleRootInput: string, limits: BundleLimits): InspectedSkillBundle {
  const bundleRoot = realDirectory(bundleRootInput, "Agent Skill bundle");
  validateBundleTree(bundleRoot, limits);
  const skillPath = join(bundleRoot, "SKILL.md");
  if (!existsSync(skillPath)) throw new Error(`Agent Skill bundle is missing SKILL.md: ${bundleRoot}`);
  const info = lstatSync(skillPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Agent Skill SKILL.md must be a regular file: ${skillPath}`);
  if (info.size <= 0 || info.size > limits.maxSkillBytes) {
    throw new Error(`Agent Skill SKILL.md size ${info.size} is outside allowed range 1..${limits.maxSkillBytes}`);
  }
  const bytes = readFileSync(skillPath);
  if (bytes.includes(0)) throw new Error(`Agent Skill SKILL.md contains NUL bytes: ${skillPath}`);
  const metadata = parseAgentSkillMetadata(bytes.toString("utf8"));
  if (!metadata.modelInvocable) {
    throw new Error(`Agent Skill ${metadata.name} disables model invocation and cannot satisfy a worker capability need`);
  }
  return {
    bundleRoot,
    skillPath,
    metadata,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
  };
}

export function parseAgentSkillMetadata(text: string): AgentSkillMetadata {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") throw new Error("Agent Skill SKILL.md must begin with YAML frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) throw new Error("Agent Skill SKILL.md frontmatter is not terminated");
  const frontmatter = lines.slice(1, end);
  const name = frontmatterScalar(frontmatter, "name");
  const description = frontmatterScalar(frontmatter, "description");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Agent Skill name must be kebab-case: ${name}`);
  }
  if (!description.trim()) throw new Error("Agent Skill description must not be empty");
  const disabled = frontmatterBoolean(frontmatter, "disable-model-invocation");
  return { name, description, modelInvocable: disabled !== true };
}

function frontmatterScalar(lines: string[], key: string): string {
  const matcher = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = matcher.exec(lines[index]!.trimEnd());
    if (!match) continue;
    const raw = match[1]!.trim();
    if (raw === "|" || raw === ">") {
      const block: string[] = [];
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor]!;
        if (line && !/^\s/.test(line)) break;
        block.push(line.trim());
      }
      return block.filter(Boolean).join(raw === ">" ? " " : "\n").trim();
    }
    return unquoteYamlScalar(raw);
  }
  throw new Error(`Agent Skill frontmatter requires ${key}`);
}

function frontmatterBoolean(lines: string[], key: string): boolean | undefined {
  const matcher = new RegExp(`^${escapeRegExp(key)}\\s*:\\s*(.*)$`);
  const line = lines.find(value => matcher.test(value.trimEnd()));
  if (!line) return undefined;
  const match = matcher.exec(line.trimEnd());
  const value = unquoteYamlScalar(match?.[1]?.trim() ?? "").toLowerCase();
  if (["true", "yes", "on", "1"].includes(value)) return true;
  if (["false", "no", "off", "0"].includes(value)) return false;
  throw new Error(`Agent Skill ${key} must be a boolean value`);
}

function unquoteYamlScalar(value: string): string {
  if (value.length >= 2 && ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}

function validateBundleTree(root: string, limits: BundleLimits): void {
  const rootReal = realpathSync(root);
  let files = 0;
  let totalBytes = 0;
  walk(rootReal);

  function walk(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path);
        if (isAbsolute(target)) throw new Error(`Agent Skill bundle contains absolute symlink: ${relative(rootReal, path)}`);
        const resolvedTarget = realpathSync(path);
        assertWithin(rootReal, resolvedTarget, relative(rootReal, path));
        continue;
      }
      if (stat.isDirectory()) {
        walk(path);
        continue;
      }
      if (!stat.isFile()) throw new Error(`Agent Skill bundle contains unsupported filesystem entry: ${relative(rootReal, path)}`);
      files += 1;
      totalBytes += stat.size;
      if (files > limits.maxBundleFiles) throw new Error(`Agent Skill bundle exceeds file limit ${limits.maxBundleFiles}`);
      if (totalBytes > limits.maxBundleBytes) throw new Error(`Agent Skill bundle exceeds byte limit ${limits.maxBundleBytes}`);
    }
  }
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

function prepareOwnedDirectory(workspace: string, name: string): string {
  const path = join(workspace, name);
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Mission-owned directory is unsafe: ${path}`);
    const real = realpathSync(path);
    assertWithin(workspace, real, name);
    return real;
  }
  mkdirSync(path, { recursive: false });
  return realpathSync(path);
}

function realDirectory(path: string, label: string): string {
  const absolute = resolve(path);
  if (!existsSync(absolute)) throw new Error(`${label} does not exist: ${absolute}`);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`${label} must be a real directory: ${absolute}`);
  return realpathSync(absolute);
}

function bundleLimits(options: {
  maxSkillBytes?: number;
  maxBundleBytes?: number;
  maxBundleFiles?: number;
}): BundleLimits {
  return {
    maxSkillBytes: Math.max(1_024, options.maxSkillBytes ?? 128 * 1_024),
    maxBundleBytes: Math.max(1_024, options.maxBundleBytes ?? 16 * 1024 * 1024),
    maxBundleFiles: Math.max(1, options.maxBundleFiles ?? 1_024)
  };
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`Agent Skill bundle path escapes root: ${label}`);
  }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "skill";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
