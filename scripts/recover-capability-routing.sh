#!/usr/bin/env bash
set -euo pipefail

cat > src/core/domain/capability.ts <<'EOF'
export type CapabilityKind = "skill" | "tool" | "mcp" | "agent" | "runtime" | "library" | "cli" | "application" | "workflow";
export type RiskLevel = "low" | "medium" | "high" | "blocked";
export type CapabilityNeedStatus = "checking-installed" | "discovering" | "evaluating" | "acquiring" | "available" | "unresolved";

export interface CapabilityDescriptor {
  id: string;
  kind: CapabilityKind;
  name: string;
  description: string;
  hostNative: boolean;
  available: boolean;
  invocationRef?: string;
  permissions: string[];
  revision?: string;
  contentHash?: string;
  sourceUri?: string;
  scope: "host" | "mission" | "trusted-cache";
  metadata?: Record<string, unknown>;
}

export interface CapabilityNeed {
  id: string;
  missionId: string;
  objective: string;
  requiredFunctions: string[];
  desiredInputs: string[];
  desiredOutputs: string[];
  purpose: "production" | "verification" | "research" | "integration";
  urgency: "blocking" | "high-value" | "optional-improvement";
  acquisitionAllowed: boolean;
  maxRisk: RiskLevel;
  requirementRefs: string[];
  gapRefs: string[];
  status?: CapabilityNeedStatus;
  resolvedCapabilityRef?: string;
}

export interface CapabilityCandidate {
  id: string;
  sourceType: "host" | "agent-skill" | "mcp-registry" | "github" | "npm" | "pypi" | "cargo" | "other";
  sourceUri: string;
  name: string;
  description?: string;
  candidateKind: CapabilityKind;
  resolvedRevision?: string;
  contentHash?: string;
  status: "discovered" | "inspecting" | "rejected" | "quarantined" | "verified" | "activated";
  metadata?: Record<string, unknown>;
}

export interface MaterializedCapabilityCandidate {
  candidate: CapabilityCandidate;
  root: string;
  resolvedRevision: string;
  contentHash: string;
}

export interface SecurityFinding {
  severity: RiskLevel;
  category: string;
  detail: string;
  file?: string;
}

export interface SecurityAssessment {
  candidateId: string;
  overall: RiskLevel;
  findings: SecurityFinding[];
  requestedPermissions: string[];
  recommendedAction: "sandbox" | "approval_required" | "reject";
}

export interface SandboxAssessment {
  candidateId: string;
  passed: boolean;
  mode: "instruction" | "node-cli" | "generic";
  observations: string[];
  invocationRef?: string;
  error?: string;
}

export interface AcquisitionReceipt {
  id: string;
  missionId: string;
  capabilityNeedRef: string;
  candidateId: string;
  sourceUri: string;
  resolvedRevision: string;
  contentHash: string;
  security: SecurityAssessment;
  sandbox: SandboxAssessment;
  capabilityRef?: string;
  status: "activated" | "rejected" | "approval_required" | "failed";
  createdAt: string;
}
EOF

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/domain/event.ts')
s=p.read_text()
s=s.replace('  | "capability.need.created"\n', '  | "capability.need.created"\n  | "capability.need.updated"\n')
s=s.replace('  | "capability.candidate.discovered"\n', '  | "capability.candidate.discovered"\n  | "capability.candidate.materialized"\n  | "capability.candidate.scanned"\n  | "capability.candidate.sandboxed"\n  | "capability.acquisition.receipt"\n')
p.write_text(s)
PY

cat > src/core/capabilities/materializer.ts <<'EOF'
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CapabilityCandidate, MaterializedCapabilityCandidate } from "../domain/capability.ts";
import { ProcessManager } from "../../execution/local/process-manager.ts";

export interface CandidateMaterializer {
  materialize(candidate: CapabilityCandidate): Promise<MaterializedCapabilityCandidate>;
}

/** Fetches source without running repository code and pins it to an exact Git commit. */
export class GitCandidateMaterializer implements CandidateMaterializer {
  private readonly quarantineRoot: string;
  private readonly processes: ProcessManager;

  constructor(quarantineRoot: string, processes = new ProcessManager()) {
    this.quarantineRoot = quarantineRoot;
    this.processes = processes;
    mkdirSync(quarantineRoot, { recursive: true });
  }

  async materialize(candidate: CapabilityCandidate): Promise<MaterializedCapabilityCandidate> {
    const source = normalizeGitSource(candidate.sourceUri, candidate.resolvedRevision);
    const root = join(this.quarantineRoot, safeName(candidate.id));
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    const repo = join(root, "repo");
    await this.git(["clone", "--no-checkout", "--filter=blob:none", "--quiet", source.cloneUrl, repo], root);

    let revision: string;
    const requestedRevision = candidate.resolvedRevision ?? source.requestedRevision;
    if (requestedRevision) {
      await this.git(["-C", repo, "fetch", "--quiet", "--depth=1", "origin", requestedRevision], root);
      revision = (await this.git(["-C", repo, "rev-parse", "FETCH_HEAD"], root)).trim();
    } else {
      revision = (await this.git(["-C", repo, "rev-parse", "HEAD"], root)).trim();
    }
    if (!/^[0-9a-f]{40}$/i.test(revision)) throw new Error(`Unable to pin exact Git revision for ${candidate.sourceUri}`);
    await this.git(["-C", repo, "checkout", "--quiet", "--detach", revision], root);
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const requestedSkillName = typeof candidate.metadata?.skillName === "string" ? candidate.metadata.skillName : undefined;
    const materializedRoot = source.subpath
      ? resolveSubpath(repo, source.subpath)
      : requestedSkillName
        ? resolveSkillRoot(repo, requestedSkillName)
        : repo;
    const contentHash = hashDirectory(materializedRoot);
    return {
      candidate: {
        ...candidate,
        resolvedRevision: revision,
        contentHash,
        status: "quarantined",
        metadata: {
          ...(candidate.metadata ?? {}),
          ...(source.subpath ? { subpath: source.subpath } : {}),
          ...(requestedSkillName ? { selectedSkillRoot: relative(repo, materializedRoot) || "." } : {})
        }
      },
      root: materializedRoot,
      resolvedRevision: revision,
      contentHash
    };
  }

  private async git(args: string[], cwd: string): Promise<string> {
    const result = await this.processes.run({ command: "git", args, cwd, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 60_000 });
    if (result.timedOut || result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
    return result.stdout;
  }
}

function safeName(value: string) { return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }

function hashDirectory(root: string): string {
  const hash = createHash("sha256");
  for (const path of walk(root)) {
    hash.update(path.slice(root.length));
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function* walk(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && statSync(path).size <= 25_000_000) yield path;
  }
}

function normalizeGitSource(sourceUri: string, explicitRevision?: string): { cloneUrl: string; requestedRevision?: string; subpath?: string } {
  if (sourceUri.startsWith("file://") || existsSync(sourceUri)) return { cloneUrl: sourceUri, requestedRevision: explicitRevision };
  if (/^[\w.-]+\/[\w.-]+$/.test(sourceUri)) return { cloneUrl: `https://github.com/${sourceUri}.git`, requestedRevision: explicitRevision };
  const tree = sourceUri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/tree\/([^/]+)(?:\/(.*))?$/i);
  if (tree) return { cloneUrl: `https://github.com/${tree[1]}/${tree[2]}.git`, requestedRevision: explicitRevision ?? tree[3], subpath: tree[4] };
  const repo = sourceUri.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#]+?)(?:\.git)?\/?$/i);
  if (repo) return { cloneUrl: `https://github.com/${repo[1]}/${repo[2]}.git`, requestedRevision: explicitRevision };
  if (sourceUri.endsWith(".git")) return { cloneUrl: sourceUri, requestedRevision: explicitRevision };
  throw new Error(`Git materializer only accepts Git repository sources: ${sourceUri}`);
}

function resolveSubpath(root: string, subpath: string): string {
  const target = resolve(root, subpath);
  const rel = relative(resolve(root), target);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Candidate subpath escapes repository: ${subpath}`);
  if (!statExists(target)) throw new Error(`Candidate subpath does not exist: ${subpath}`);
  return target;
}

function resolveSkillRoot(repoRoot: string, skillName: string): string {
  const roots = findSkillRoots(repoRoot, 8);
  if (roots.length === 0) throw new Error(`Agent Skills candidate contains no SKILL.md: ${skillName}`);
  const wanted = normalizeSkillName(skillName);
  const byFolder = roots.filter(root => normalizeSkillName(basename(root)) === wanted);
  if (byFolder.length === 1) return byFolder[0]!;
  const byFrontmatter = roots.filter(root => {
    const text = readFileSync(join(root, "SKILL.md"), "utf8").slice(0, 4000);
    const name = text.match(/^---[\s\S]*?^name:\s*["']?([^\n"']+)["']?\s*$/m)?.[1]?.trim();
    return name ? normalizeSkillName(name) === wanted : false;
  });
  if (byFrontmatter.length === 1) return byFrontmatter[0]!;
  if (roots.length === 1) return roots[0]!;
  throw new Error(`Unable to select Agent Skill ${skillName}; repository contains ${roots.length} SKILL.md files`);
}

function findSkillRoots(root: string, depth: number): string[] {
  if (depth < 0) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (!entry.isDirectory()) continue;
    if (existsSync(join(path, "SKILL.md"))) result.push(path);
    result.push(...findSkillRoots(path, depth - 1));
  }
  if (existsSync(join(root, "SKILL.md"))) result.unshift(root);
  return [...new Set(result)];
}

function normalizeSkillName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

function statExists(path: string) { try { statSync(path); return true; } catch { return false; } }
EOF

cat > src/core/capabilities/sandbox/smoke-tester.ts <<'EOF'
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
EOF

cat > src/core/capabilities/secure-acquisition-service.ts <<'EOF'
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  AcquisitionReceipt,
  CapabilityCandidate,
  CapabilityDescriptor,
  CapabilityNeed,
  MaterializedCapabilityCandidate,
  SandboxAssessment,
  SecurityAssessment
} from "../domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "./discovery-provider.ts";
import type { CandidateMaterializer } from "./materializer.ts";
import { CandidateRanker } from "./candidate-ranker.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import { PolicyEngine } from "../policy/policy-engine.ts";
import type { CapabilitySmokeTester } from "./sandbox/smoke-tester.ts";
import type { MissionCapabilityOverlay } from "./mission-capability-overlay.ts";

export type AcquisitionTraceType =
  | "capability.candidate.discovered"
  | "capability.candidate.materialized"
  | "capability.candidate.scanned"
  | "capability.candidate.sandboxed"
  | "capability.activated"
  | "capability.rejected"
  | "capability.acquisition.receipt";

export interface AcquisitionObserver {
  onTrace(type: AcquisitionTraceType, payload: unknown): Promise<void> | void;
  requestApproval?(input: { need: CapabilityNeed; candidate: CapabilityCandidate; security: SecurityAssessment }): Promise<boolean>;
}

export interface AcquisitionOutcome {
  capability?: CapabilityDescriptor;
  receipt: AcquisitionReceipt;
}

export class SecureAcquisitionService {
  private readonly providers: CapabilityDiscoveryProvider[];
  private readonly materializer: CandidateMaterializer;
  private readonly smoke: CapabilitySmokeTester;
  private readonly overlay: MissionCapabilityOverlay;
  private readonly activationRoot: string;
  private readonly ranker: CandidateRanker;
  private readonly scanner: StaticSecurityScanner;
  private readonly policy: PolicyEngine;
  private readonly maxCandidates: number;

  constructor(options: {
    providers: CapabilityDiscoveryProvider[];
    materializer: CandidateMaterializer;
    smoke: CapabilitySmokeTester;
    overlay: MissionCapabilityOverlay;
    activationRoot: string;
    ranker?: CandidateRanker;
    scanner?: StaticSecurityScanner;
    policy?: PolicyEngine;
    maxCandidates?: number;
  }) {
    this.providers = options.providers;
    this.materializer = options.materializer;
    this.smoke = options.smoke;
    this.overlay = options.overlay;
    this.activationRoot = options.activationRoot;
    this.ranker = options.ranker ?? new CandidateRanker();
    this.scanner = options.scanner ?? new StaticSecurityScanner();
    this.policy = options.policy ?? new PolicyEngine();
    this.maxCandidates = Math.max(1, options.maxCandidates ?? 3);
  }

  async acquire(need: CapabilityNeed, observer: AcquisitionObserver): Promise<AcquisitionOutcome> {
    const discovered = (await Promise.all(this.providers.map(provider => provider.discover(need)))).flat();
    const unique = new Map<string, CapabilityCandidate>();
    for (const candidate of discovered) unique.set(`${candidate.sourceType}:${candidate.sourceUri}:${candidate.name}`, candidate);
    const ranked = this.ranker.rank(need, [...unique.values()]).slice(0, this.maxCandidates);
    if (ranked.length === 0) return this.failedReceipt(need, undefined, "No capability candidates discovered", observer);

    let lastFailure = "No candidate passed acquisition";
    for (const rankedCandidate of ranked) {
      const original = rankedCandidate.candidate;
      await observer.onTrace("capability.candidate.discovered", { needId: need.id, candidate: original, score: rankedCandidate.score });
      let materialized: MaterializedCapabilityCandidate;
      try {
        materialized = await this.materializer.materialize(original);
        await observer.onTrace("capability.candidate.materialized", { needId: need.id, candidate: materialized.candidate, root: materialized.root, resolvedRevision: materialized.resolvedRevision, contentHash: materialized.contentHash });
      } catch (error) {
        lastFailure = errorMessage(error);
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: original, reason: lastFailure });
        continue;
      }

      const security = this.scanner.scan(materialized.candidate, materialized.root);
      await observer.onTrace("capability.candidate.scanned", { needId: need.id, candidateId: original.id, security });
      const decision = this.policy.evaluateSecurity(security);
      if (decision.action === "deny") {
        lastFailure = decision.reason;
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, security });
        continue;
      }
      if (decision.action === "require_approval") {
        const approved = await observer.requestApproval?.({ need, candidate: materialized.candidate, security }) ?? false;
        if (!approved) {
          const receipt = receiptFor(need, materialized, security, { candidateId: original.id, passed: false, mode: "generic", observations: [], error: "Approval required" }, "approval_required");
          await observer.onTrace("capability.acquisition.receipt", { receipt });
          return { receipt };
        }
      }
      if (riskRank(security.overall) > riskRank(need.maxRisk)) {
        lastFailure = `Candidate risk ${security.overall} exceeds need maxRisk ${need.maxRisk}`;
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, security });
        continue;
      }

      const sandbox = await this.smoke.test(materialized);
      await observer.onTrace("capability.candidate.sandboxed", { needId: need.id, candidateId: original.id, sandbox });
      if (!sandbox.passed || !sandbox.invocationRef) {
        lastFailure = sandbox.error ?? "Capability smoke test failed";
        await observer.onTrace("capability.rejected", { needId: need.id, candidate: materialized.candidate, reason: lastFailure, sandbox });
        continue;
      }

      const capability = this.activate(need, materialized, sandbox);
      const receipt = receiptFor(need, materialized, security, sandbox, "activated", capability.id);
      await observer.onTrace("capability.activated", { needId: need.id, capability, candidate: materialized.candidate });
      await observer.onTrace("capability.acquisition.receipt", { receipt });
      return { capability, receipt };
    }
    return this.failedReceipt(need, ranked[0]?.candidate, lastFailure, observer);
  }

  private activate(need: CapabilityNeed, materialized: MaterializedCapabilityCandidate, sandbox: SandboxAssessment): CapabilityDescriptor {
    const capabilityId = `mission-capability:${need.id}:${materialized.resolvedRevision.slice(0, 12)}`;
    const destination = join(this.activationRoot, need.missionId, safeName(capabilityId));
    rmSync(destination, { recursive: true, force: true });
    mkdirSync(destination, { recursive: true });
    cpSync(materialized.root, destination, { recursive: true, dereference: false });
    const relativeInvocation = relativeToRoot(materialized.root, sandbox.invocationRef!);
    const invocationRef = join(destination, relativeInvocation);
    const capability: CapabilityDescriptor = {
      id: capabilityId,
      kind: materialized.candidate.candidateKind,
      name: materialized.candidate.name,
      description: materialized.candidate.description ?? need.objective,
      hostNative: false,
      available: true,
      invocationRef,
      permissions: [],
      revision: materialized.resolvedRevision,
      contentHash: materialized.contentHash,
      sourceUri: materialized.candidate.sourceUri,
      scope: "mission",
      metadata: { acquisitionNeedId: need.id, smokeMode: sandbox.mode }
    };
    this.overlay.activate(need.missionId, capability);
    return capability;
  }

  private async failedReceipt(need: CapabilityNeed, candidate: CapabilityCandidate | undefined, reason: string, observer: AcquisitionObserver): Promise<AcquisitionOutcome> {
    const receipt: AcquisitionReceipt = {
      id: randomUUID(),
      missionId: need.missionId,
      capabilityNeedRef: need.id,
      candidateId: candidate?.id ?? "none",
      sourceUri: candidate?.sourceUri ?? "",
      resolvedRevision: candidate?.resolvedRevision ?? "",
      contentHash: candidate?.contentHash ?? "",
      security: { candidateId: candidate?.id ?? "none", overall: "blocked", findings: [{ severity: "blocked", category: "acquisition", detail: reason }], requestedPermissions: [], recommendedAction: "reject" },
      sandbox: { candidateId: candidate?.id ?? "none", passed: false, mode: "generic", observations: [], error: reason },
      status: "failed",
      createdAt: new Date().toISOString()
    };
    await observer.onTrace("capability.acquisition.receipt", { receipt });
    return { receipt };
  }
}

function receiptFor(need: CapabilityNeed, materialized: MaterializedCapabilityCandidate, security: SecurityAssessment, sandbox: SandboxAssessment, status: AcquisitionReceipt["status"], capabilityRef?: string): AcquisitionReceipt {
  return {
    id: randomUUID(), missionId: need.missionId, capabilityNeedRef: need.id, candidateId: materialized.candidate.id,
    sourceUri: materialized.candidate.sourceUri, resolvedRevision: materialized.resolvedRevision, contentHash: materialized.contentHash,
    security, sandbox, capabilityRef, status, createdAt: new Date().toISOString()
  };
}
function safeName(value: string) { return basename(value).replace(/[^a-zA-Z0-9._-]/g, "_"); }
function relativeToRoot(root: string, path: string) { return path.startsWith(root) ? path.slice(root.length).replace(/^[/\\]+/, "") : basename(path); }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error); }
function riskRank(value: "low" | "medium" | "high" | "blocked") { return ({ low: 0, medium: 1, high: 2, blocked: 3 } as const)[value]; }
EOF

cat > src/core/capabilities/filesystem-candidate-inspector.ts <<'EOF'
import type { CapabilityCandidate, SecurityAssessment } from "../domain/capability.ts";
import { StaticSecurityScanner } from "./static-security-scanner.ts";
import type { CandidateInspector } from "./acquisition-service.ts";
import type { CandidateMaterializer } from "./materializer.ts";

export class FilesystemCandidateInspector implements CandidateInspector {
  private readonly materializer: CandidateMaterializer;
  private readonly scanner: StaticSecurityScanner;
  constructor(materializer: CandidateMaterializer, scanner = new StaticSecurityScanner()) {
    this.materializer = materializer;
    this.scanner = scanner;
  }
  async inspect(candidate: CapabilityCandidate): Promise<SecurityAssessment> {
    const materialized = await this.materializer.materialize(candidate);
    return this.scanner.scan(materialized.candidate, materialized.root);
  }
}
EOF

cat > src/core/capabilities/providers/agent-skills-cli-client.ts <<'EOF'
import type { AgentSkillsClient, AgentSkillsSearchResult } from "./agent-skills-provider.ts";
import { ProcessManager } from "../../../execution/local/process-manager.ts";

export interface AgentSkillsCliClientOptions {
  packageVersion?: string;
  timeoutMs?: number;
  processManager?: ProcessManager;
  command?: string;
}

/** Discovery adapter for the Vercel Agent Skills CLI. It uses find only. */
export class AgentSkillsCliClient implements AgentSkillsClient {
  readonly packageVersion: string;
  private readonly timeoutMs: number;
  private readonly processes: ProcessManager;
  private readonly command: string;

  constructor(options: AgentSkillsCliClientOptions = {}) {
    this.packageVersion = options.packageVersion ?? "1.7.4";
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.processes = options.processManager ?? new ProcessManager();
    this.command = options.command ?? (process.platform === "win32" ? "npx.cmd" : "npx");
  }

  async find(query: string, limit: number): Promise<AgentSkillsSearchResult[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const result = await this.processes.run({
      command: this.command,
      args: ["--yes", `skills@${this.packageVersion}`, "find", trimmed],
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        USERPROFILE: process.env.USERPROFILE ?? "",
        DISABLE_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        NO_COLOR: "1",
        CI: "1"
      },
      timeoutMs: this.timeoutMs
    });
    if (result.timedOut || result.exitCode !== 0) {
      throw new Error(`Agent Skills discovery failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    return parseAgentSkillsFindOutput(result.stdout).slice(0, Math.max(1, limit));
  }
}

export function parseAgentSkillsFindOutput(output: string): AgentSkillsSearchResult[] {
  const results = new Map<string, AgentSkillsSearchResult>();
  const ansi = /\u001b\[[0-9;]*m/g;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.replace(ansi, "").trim();
    if (!line) continue;
    for (const match of line.matchAll(/(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/g)) {
      const owner = match[1]!;
      const repo = match[2]!.replace(/\.git$/i, "");
      const skillName = match[3]!;
      const key = `${owner}/${repo}@${skillName}`.toLowerCase();
      results.set(key, {
        name: skillName,
        sourceUri: `https://github.com/${owner}/${repo}`,
        description: `Agent Skill ${skillName} from ${owner}/${repo}`
      });
    }
    for (const match of line.matchAll(/https?:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/tree\/([^/\s]+)\/([^\s)]+)/g)) {
      const owner = match[1]!;
      const repo = match[2]!.replace(/\.git$/i, "");
      const ref = match[3]!;
      const path = match[4]!.replace(/[),.;]+$/, "");
      const skillName = path.split("/").filter(Boolean).at(-1) ?? repo;
      const key = `${owner}/${repo}@${skillName}`.toLowerCase();
      results.set(key, {
        name: skillName,
        sourceUri: `https://github.com/${owner}/${repo}/tree/${ref}/${path}`,
        revision: ref,
        description: `Agent Skill ${skillName} from ${owner}/${repo}`
      });
    }
  }
  return [...results.values()];
}
EOF

cat > src/core/capabilities/providers/github-rest-client.ts <<'EOF'
import type { GitHubRepositorySummary, GitHubSearchClient } from "./github-provider.ts";

export interface GitHubRestSearchClientOptions {
  token?: string;
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GitHubRestSearchClient implements GitHubSearchClient {
  private readonly token?: string;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubRestSearchClientOptions = {}) {
    this.token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.userAgent = options.userAgent ?? "mission-runtime-capability-discovery";
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchRepositories(query: string, limit: number): Promise<GitHubRepositorySummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const perPage = Math.max(1, Math.min(50, limit));
    const url = new URL(`${this.baseUrl}/search/repositories`);
    url.searchParams.set("q", trimmed);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(perPage));

    const headers = new Headers({
      Accept: "application/vnd.github+json",
      "User-Agent": this.userAgent,
      "X-GitHub-Api-Version": "2022-11-28"
    });
    if (this.token) headers.set("Authorization", `Bearer ${this.token}`);

    const response = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(this.timeoutMs) });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`GitHub repository search failed (${response.status}): ${detail.slice(0, 300)}`);
    }
    const payload = await response.json() as {
      items?: Array<{
        full_name?: string;
        description?: string | null;
        html_url?: string;
        default_branch?: string;
        stargazers_count?: number;
      }>;
    };
    return (payload.items ?? []).slice(0, perPage).flatMap(item => {
      if (!item.full_name || !item.html_url) return [];
      return [{
        fullName: item.full_name,
        description: item.description ?? undefined,
        url: item.html_url,
        defaultBranch: item.default_branch,
        stars: item.stargazers_count
      }];
    });
  }
}
EOF

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/capabilities/providers/agent-skills-provider.ts')
s=p.read_text()
s=s.replace('      resolvedRevision: result.revision,\n      status: "discovered"', '      resolvedRevision: result.revision,\n      status: "discovered",\n      metadata: { skillName: result.name, discoveryProvider: "agent-skills" }')
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/events/projection-store.ts')
s=p.read_text()
s=s.replace('import type { Artifact } from "../domain/artifact.ts";\n', 'import type { Artifact } from "../domain/artifact.ts";\nimport type { AcquisitionReceipt, CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";\n')
s=s.replace('  listArtifacts(missionId: string): Promise<Artifact[]>;\n', '  listArtifacts(missionId: string): Promise<Artifact[]>;\n  listCapabilityNeeds(missionId: string): Promise<CapabilityNeed[]>;\n  listCapabilities(missionId: string): Promise<CapabilityDescriptor[]>;\n  listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]>;\n')
p.write_text(s)
PY

cat >> src/persistence/sqlite/schema.sql <<'EOF'

CREATE TABLE IF NOT EXISTS capability_needs (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  status TEXT NOT NULL,
  urgency TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_needs_mission_status ON capability_needs(mission_id, status, urgency);

CREATE TABLE IF NOT EXISTS capability_candidates (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  need_id TEXT NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  revision TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_capability_candidates_need ON capability_candidates(mission_id, need_id, status);

CREATE TABLE IF NOT EXISTS acquisition_receipts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  need_id TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_acquisition_receipts_need ON acquisition_receipts(mission_id, need_id, created_at);
EOF

python3 - <<'PY'
from pathlib import Path
p=Path('src/persistence/sqlite/sqlite-projection-store.ts')
s=p.read_text()
s=s.replace('import type { Artifact } from "../../core/domain/artifact.ts";\n', 'import type { Artifact } from "../../core/domain/artifact.ts";\nimport type { AcquisitionReceipt, CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";\n')
s=s.replace('    db.prepare("DELETE FROM capabilities WHERE mission_id = ?").run(missionId);\n', '    db.prepare("DELETE FROM capabilities WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM capability_needs WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM capability_candidates WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM acquisition_receipts WHERE mission_id = ?").run(missionId);\n')
needle='''  async listArtifacts(missionId: string): Promise<Artifact[]> {\n    const rows = this.database.db.prepare("SELECT metadata_json FROM artifacts WHERE mission_id = ? ORDER BY logical_name ASC, version ASC")\n      .all(missionId) as Array<{ metadata_json: string }>;\n    return rows.map(row => JSON.parse(row.metadata_json) as Artifact);\n  }\n'''
insert=needle+'''\n  async listCapabilityNeeds(missionId: string): Promise<CapabilityNeed[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM capability_needs WHERE mission_id = ? ORDER BY created_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as CapabilityNeed);\n  }\n\n  async listCapabilities(missionId: string): Promise<CapabilityDescriptor[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM capabilities WHERE mission_id = ? ORDER BY created_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as CapabilityDescriptor);\n  }\n\n  async listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM acquisition_receipts WHERE mission_id = ? ORDER BY created_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as AcquisitionReceipt);\n  }\n'''
if needle in s and 'listCapabilityNeeds' not in s:
    s=s.replace(needle,insert)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/persistence/sqlite/sqlite-entity-projector.ts')
s=p.read_text()
s=s.replace('import type { Artifact } from "../../core/domain/artifact.ts";\n', 'import type { Artifact } from "../../core/domain/artifact.ts";\nimport type { AcquisitionReceipt, CapabilityCandidate, CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";\n')
marker='''      case "capability.activated": {\n        const capability = payload.capability ?? payload;\n        if (!capability?.id) return;\n        db.prepare(`INSERT INTO capabilities (id, mission_id, scope, kind, status, source_uri, revision, data_json, created_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json`)\n          .run(capability.id, event.missionId, capability.scope ?? "mission", capability.kind ?? "tool", capability.status ?? "available", capability.sourceUri ?? null, capability.revision ?? null, JSON.stringify(capability), event.createdAt);\n        return;\n      }\n'''
replacement='''      case "capability.need.created": {\n        const need = (payload.need ?? payload) as CapabilityNeed;\n        if (!need?.id) return;\n        const normalized: CapabilityNeed = { ...need, missionId: event.missionId, status: need.status ?? "checking-installed" };\n        db.prepare(`INSERT INTO capability_needs (id, mission_id, status, urgency, data_json, created_at, updated_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?)\n          ON CONFLICT(id) DO UPDATE SET status = excluded.status, urgency = excluded.urgency, data_json = excluded.data_json, updated_at = excluded.updated_at`)\n          .run(normalized.id, event.missionId, normalized.status, normalized.urgency, JSON.stringify(normalized), event.createdAt, event.createdAt);\n        return;\n      }\n      case "capability.need.updated": {\n        const row = db.prepare("SELECT data_json FROM capability_needs WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;\n        if (!row) return;\n        const need = JSON.parse(row.data_json) as CapabilityNeed;\n        if (payload.status) need.status = payload.status;\n        if (payload.resolvedCapabilityRef) need.resolvedCapabilityRef = payload.resolvedCapabilityRef;\n        db.prepare("UPDATE capability_needs SET status = ?, data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")\n          .run(need.status ?? "unresolved", JSON.stringify(need), event.createdAt, need.id, event.missionId);\n        return;\n      }\n      case "capability.candidate.discovered":\n      case "capability.candidate.materialized":\n      case "capability.candidate.scanned":\n      case "capability.candidate.sandboxed":\n      case "capability.rejected": {\n        const candidate = (payload.candidate ?? payload) as CapabilityCandidate;\n        const candidateId = candidate?.id ?? payload.candidateId;\n        if (!candidateId) return;\n        const existing = db.prepare("SELECT data_json FROM capability_candidates WHERE id = ?").get(candidateId) as { data_json: string } | undefined;\n        const current = existing ? JSON.parse(existing.data_json) : {};\n        const merged = { ...current, ...candidate, ...payload, id: candidateId };\n        const status = event.type === "capability.rejected" ? "rejected"\n          : event.type === "capability.candidate.materialized" ? "quarantined"\n          : event.type === "capability.candidate.sandboxed" && payload.sandbox?.passed ? "verified"\n          : merged.status ?? "discovered";\n        merged.status = status;\n        db.prepare(`INSERT INTO capability_candidates (id, mission_id, need_id, status, source_type, source_uri, revision, data_json, created_at, updated_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)\n          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json, updated_at = excluded.updated_at`)\n          .run(candidateId, event.missionId, payload.needId ?? merged.needId ?? "", status, merged.sourceType ?? "other", merged.sourceUri ?? "", merged.resolvedRevision ?? null, JSON.stringify(merged), event.createdAt, event.createdAt);\n        return;\n      }\n      case "capability.acquisition.receipt": {\n        const receipt = (payload.receipt ?? payload) as AcquisitionReceipt;\n        if (!receipt?.id) return;\n        db.prepare(`INSERT OR REPLACE INTO acquisition_receipts (id, mission_id, need_id, candidate_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)\n          .run(receipt.id, event.missionId, receipt.capabilityNeedRef, receipt.candidateId, receipt.status, JSON.stringify(receipt), receipt.createdAt ?? event.createdAt);\n        return;\n      }\n      case "capability.activated": {\n        const capability = (payload.capability ?? payload) as CapabilityDescriptor;\n        if (!capability?.id) return;\n        db.prepare(`INSERT INTO capabilities (id, mission_id, scope, kind, status, source_uri, revision, data_json, created_at)\n          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)\n          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json`)\n          .run(capability.id, event.missionId, capability.scope ?? "mission", capability.kind ?? "tool", capability.available === false ? "unavailable" : "available", capability.sourceUri ?? null, capability.revision ?? null, JSON.stringify(capability), event.createdAt);\n        if (payload.needId) {\n          const needRow = db.prepare("SELECT data_json FROM capability_needs WHERE id = ? AND mission_id = ?").get(payload.needId, event.missionId) as { data_json: string } | undefined;\n          if (needRow) {\n            const need = JSON.parse(needRow.data_json) as CapabilityNeed;\n            need.status = "available"; need.resolvedCapabilityRef = capability.id;\n            db.prepare("UPDATE capability_needs SET status = 'available', data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")\n              .run(JSON.stringify(need), event.createdAt, need.id, event.missionId);\n          }\n        }\n        return;\n      }\n'''
if marker not in s:
    raise SystemExit('sqlite entity marker not found')
s=s.replace(marker,replacement)
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/planning/deliberation-provider.ts')
s=p.read_text()
s=s.replace('import type { AcceptanceContract, MissionSpec, MissionState } from "../domain/mission.ts";\n', 'import type { AcceptanceContract, MissionSpec, MissionState } from "../domain/mission.ts";\nimport type { CapabilityNeed } from "../domain/capability.ts";\n')
s=s.replace('export interface FrontierProposal {\n  workItems: WorkItem[];\n  graphRevision: number;\n}', 'export interface FrontierProposal {\n  workItems: WorkItem[];\n  capabilityNeeds?: CapabilityNeed[];\n  graphRevision: number;\n}')
p.write_text(s)

p=Path('src/core/planning/deterministic-deliberation.ts')
s=p.read_text().replace('return { workItems: [], graphRevision: input.state.graphRevision + 1 };','return { workItems: [], capabilityNeeds: [], graphRevision: input.state.graphRevision + 1 };')
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/planning/host-deliberation-provider.ts')
s=p.read_text()
s=s.replace('import type { AcceptanceContract, MissionSpec, Requirement, RequiredArtifact, RequiredValidation } from "../domain/mission.ts";\n', 'import type { AcceptanceContract, MissionSpec, Requirement, RequiredArtifact, RequiredValidation } from "../domain/mission.ts";\nimport type { CapabilityNeed } from "../domain/capability.ts";\n')
s=s.replace('''Return ONLY JSON: {"graphRevision":number,"workItems":[{"id":string,"purpose":"exploration|production|verification|repair|acquisition|integration","objective":string,"requirementRefs":string[],"gapRefs":string[],"inputArtifactRefs":string[],"capabilityNeedRefs":string[],"priority":number,"expectedOutputs":[{"logicalName":string,"type":string,"required":boolean}]}]}.\nWhen a work item produces a required deliverable, use the exact requiredArtifacts.logicalName and attach its requirementRefs. Use purpose=exploration when the direction is still uncertain and there is no stronger requirement/gap linkage.''','''Return ONLY JSON: {"graphRevision":number,"capabilityNeeds":[{"id":string,"objective":string,"requiredFunctions":string[],"desiredInputs":string[],"desiredOutputs":string[],"purpose":"production|verification|research|integration","urgency":"blocking|high-value|optional-improvement","acquisitionAllowed":boolean,"maxRisk":"low|medium|high","requirementRefs":string[],"gapRefs":string[]}],"workItems":[{"id":string,"purpose":"exploration|production|verification|repair|acquisition|integration","objective":string,"requirementRefs":string[],"gapRefs":string[],"inputArtifactRefs":string[],"capabilityNeedRefs":string[],"priority":number,"expectedOutputs":[{"logicalName":string,"type":string,"required":boolean}]}]}.\nOnly create a CapabilityNeed when the current environment may not already provide a required function. A WorkItem capabilityNeedRefs must reference ids from capabilityNeeds. When a work item produces a required deliverable, use the exact requiredArtifacts.logicalName and attach its requirementRefs. Use purpose=exploration when the direction is still uncertain and there is no stronger requirement/gap linkage.''')
old='''    return { workItems, graphRevision: nextRevision };'''
new='''    const capabilityNeeds: CapabilityNeed[] = arrayValue(value.capabilityNeeds).slice(0, 8).map((raw: any, index) => ({\n        id: stringValue(raw?.id, `need-${nextRevision}-${index + 1}`),\n        missionId: input.state.missionId,\n        objective: stringValue(raw?.objective, "Provide a capability required by the current frontier"),\n        requiredFunctions: stringArray(raw?.requiredFunctions),\n        desiredInputs: stringArray(raw?.desiredInputs),\n        desiredOutputs: stringArray(raw?.desiredOutputs),\n        purpose: capabilityPurpose(raw?.purpose),\n        urgency: capabilityUrgency(raw?.urgency),\n        acquisitionAllowed: raw?.acquisitionAllowed !== false,\n        maxRisk: capabilityRisk(raw?.maxRisk),\n        requirementRefs: stringArray(raw?.requirementRefs),\n        gapRefs: stringArray(raw?.gapRefs),\n        status: "checking-installed"\n      }));\n      return { workItems, capabilityNeeds, graphRevision: nextRevision };'''
if old not in s:
    raise SystemExit('host deliberation marker missing')
s=s.replace(old,new)
s += '''\nfunction capabilityPurpose(value: unknown): CapabilityNeed["purpose"] { return ["production","verification","research","integration"].includes(String(value)) ? value as CapabilityNeed["purpose"] : "production"; }\nfunction capabilityUrgency(value: unknown): CapabilityNeed["urgency"] { return ["blocking","high-value","optional-improvement"].includes(String(value)) ? value as CapabilityNeed["urgency"] : "blocking"; }\nfunction capabilityRisk(value: unknown): CapabilityNeed["maxRisk"] { return ["low","medium","high"].includes(String(value)) ? value as CapabilityNeed["maxRisk"] : "medium"; }\n'''
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/core/mission/controller.ts')
s=p.read_text()
needle='''      if (frontier.graphRevision > state.graphRevision) {\n        await this.emit(input.missionId, "graph.revised", { revision: frontier.graphRevision }, { type: "planner" }, `graph:${input.missionId}:${frontier.graphRevision}`);\n      }\n      for (const work of frontier.workItems) {'''
replacement='''      if (frontier.graphRevision > state.graphRevision) {\n        await this.emit(input.missionId, "graph.revised", { revision: frontier.graphRevision }, { type: "planner" }, `graph:${input.missionId}:${frontier.graphRevision}`);\n      }\n      for (const need of frontier.capabilityNeeds ?? []) {\n        await this.emit(input.missionId, "capability.need.created", { need }, { type: "planner" }, `capability-need:${need.id}`);\n      }\n      for (const work of frontier.workItems) {'''
if needle not in s:
    raise SystemExit('controller frontier marker missing')
s=s.replace(needle,replacement)
p.write_text(s)
PY

cat > src/runtime/orchestration/capability-coordinator.ts <<'EOF'
import type { CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import { CapabilityResolver } from "../../core/capabilities/resolver.ts";
import type { SecureAcquisitionService } from "../../core/capabilities/secure-acquisition-service.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";

export interface WorkCapabilityPreparation {
  status: "ready" | "acquisition_scheduled" | "blocked";
  capabilities: CapabilityDescriptor[];
  missingNeeds: CapabilityNeed[];
}

export class CapabilityCoordinator {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly host: HostAdapter;
  private readonly resolver: CapabilityResolver;
  private readonly acquisition?: SecureAcquisitionService;

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    host: HostAdapter;
    acquisition?: SecureAcquisitionService;
    resolver?: CapabilityResolver;
  }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.host = input.host;
    this.acquisition = input.acquisition;
    this.resolver = input.resolver ?? new CapabilityResolver();
  }

  async prepare(work: WorkItem): Promise<WorkCapabilityPreparation> {
    if (work.purpose === "acquisition" || work.capabilityNeedRefs.length === 0) return { status: "ready", capabilities: [], missingNeeds: [] };
    const [environment, missionCapabilities, needs] = await Promise.all([
      this.host.snapshotEnvironment(),
      this.projections.listCapabilities(work.missionId),
      this.projections.listCapabilityNeeds(work.missionId)
    ]);
    const effective = mergeCapabilities(environment.capabilities, missionCapabilities);
    const requested = work.capabilityNeedRefs.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);
    const capabilities: CapabilityDescriptor[] = [];
    const missingNeeds: CapabilityNeed[] = [];
    for (const need of requested) {
      const resolvedByRef = need.resolvedCapabilityRef ? effective.find(cap => cap.id === need.resolvedCapabilityRef && cap.available) : undefined;
      if (resolvedByRef) { capabilities.push(resolvedByRef); continue; }
      const resolution = this.resolver.resolve(need, effective);
      if (resolution.status === "resolved" && resolution.capability) {
        capabilities.push(resolution.capability);
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "available", resolvedCapabilityRef: resolution.capability.id }, { type: "controller" }, `capability-need-resolved:${need.id}:${resolution.capability.id}`);
      } else {
        missingNeeds.push(need);
      }
    }
    if (missingNeeds.length === 0) return { status: "ready", capabilities: uniqueCapabilities(capabilities), missingNeeds: [] };

    let scheduled = false;
    for (const need of missingNeeds) {
      if (!need.acquisitionAllowed || !this.acquisition) {
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "unresolved" }, { type: "controller" }, `capability-need-unresolved:${need.id}`);
        await this.controller.openGap(work.missionId, {
          id: `capability-${need.id}`,
          severity: need.urgency === "blocking" ? "major" : "minor",
          description: `Capability unavailable: ${need.objective}`,
          category: "capability",
          requirementRefs: need.requirementRefs,
          artifactRefs: []
        });
        continue;
      }
      const acquisitionId = `acquire-${need.id}`;
      const existing = (await this.projections.listWorkItems(work.missionId)).find(item => item.id === acquisitionId && !["succeeded", "invalidated", "abandoned", "superseded"].includes(item.status));
      if (!existing) {
        const now = new Date().toISOString();
        await this.controller.proposeWork({
          id: acquisitionId,
          missionId: work.missionId,
          workstreamId: work.workstreamId,
          parentWorkItemId: work.id,
          purpose: "acquisition",
          objective: `Acquire capability: ${need.objective}`,
          status: "ready",
          requirementRefs: need.requirementRefs,
          gapRefs: need.gapRefs,
          inputArtifactRefs: [],
          expectedOutputs: [],
          localAcceptanceCriteria: [{ id: `capability-ready-${need.id}`, description: `Capability ${need.id} is securely materialized, smoke-tested, and mission-local`, priority: "required" }],
          capabilityNeedRefs: [need.id],
          priority: need.urgency === "blocking" ? 100 : 60,
          graphRevision: work.graphRevision,
          createdBy: "system",
          createdAt: now,
          updatedAt: now
        });
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "discovering" }, { type: "controller" }, `capability-need-discovering:${need.id}`);
      }
      scheduled = true;
    }
    await this.controller.emit(work.missionId, "work.blocked", { id: work.id, reason: "waiting for required capability acquisition" }, { type: "controller" }, `work-capability-blocked:${work.id}`);
    return { status: scheduled ? "acquisition_scheduled" : "blocked", capabilities: [], missingNeeds };
  }

  async executeAcquisition(work: WorkItem): Promise<{ ok: boolean; capability?: CapabilityDescriptor; reason: string }> {
    const needId = work.capabilityNeedRefs[0];
    if (!needId || !this.acquisition) return { ok: false, reason: "Acquisition work has no configured acquisition service" };
    const need = (await this.projections.listCapabilityNeeds(work.missionId)).find(item => item.id === needId);
    if (!need) return { ok: false, reason: `CapabilityNeed not found: ${needId}` };
    await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "acquiring" }, { type: "controller" }, `capability-need-acquiring:${need.id}`);
    const outcome = await this.acquisition.acquire(need, {
      onTrace: async (type, payload) => {
        await this.controller.emit(work.missionId, type, payload, { type: "system" });
      },
      requestApproval: async ({ candidate, security }) => {
        const approvalId = `approval-capability-${candidate.id}`;
        await this.controller.emit(work.missionId, "approval.requested", { id: approvalId, scope: "mission", candidate, security }, { type: "controller" }, `approval-request:${approvalId}`);
        const result = await this.host.requestUserApproval({ missionId: work.missionId, title: `Enable ${candidate.name}`, reason: `Capability ${need.objective} requires approval`, details: { candidate, security } });
        await this.controller.emit(work.missionId, "approval.decided", { id: approvalId, approved: result.approved, scope: result.scope }, { type: "user" }, `approval-decision:${approvalId}`);
        return result.approved;
      }
    });
    if (!outcome.capability) {
      await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "unresolved" }, { type: "controller" }, `capability-need-failed:${need.id}:${outcome.receipt.id}`);
      return { ok: false, reason: outcome.receipt.sandbox.error ?? outcome.receipt.security.findings[0]?.detail ?? "Capability acquisition failed" };
    }
    await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "available", resolvedCapabilityRef: outcome.capability.id }, { type: "controller" }, `capability-need-available:${need.id}:${outcome.capability.id}`);
    await this.unblockDependents(work.missionId, need.id);
    return { ok: true, capability: outcome.capability, reason: "Capability acquired" };
  }

  private async unblockDependents(missionId: string, _resolvedNeedId: string): Promise<void> {
    const [workItems, needs] = await Promise.all([this.projections.listWorkItems(missionId), this.projections.listCapabilityNeeds(missionId)]);
    for (const work of workItems.filter(item => item.status === "blocked" && item.purpose !== "acquisition")) {
      const requiredNeeds = work.capabilityNeedRefs.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);
      if (requiredNeeds.length > 0 && requiredNeeds.every(need => need.status === "available")) {
        await this.controller.emit(missionId, "work.updated", { id: work.id, status: "ready" }, { type: "controller" }, `work-capability-ready:${work.id}:${requiredNeeds.map(n => n.resolvedCapabilityRef).join(",")}`);
      }
    }
  }
}

function mergeCapabilities(...groups: CapabilityDescriptor[][]): CapabilityDescriptor[] {
  const map = new Map<string, CapabilityDescriptor>();
  for (const group of groups) for (const cap of group) map.set(cap.id, cap);
  return [...map.values()];
}
function uniqueCapabilities(values: CapabilityDescriptor[]): CapabilityDescriptor[] { return mergeCapabilities(values); }
EOF

python3 - <<'PY'
from pathlib import Path
p=Path('src/runtime/mission-runtime.ts')
s=p.read_text()
s=s.replace('import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";\n', 'import { MissionOrchestrator } from "./orchestration/mission-orchestrator.ts";\nimport { CapabilityCoordinator } from "./orchestration/capability-coordinator.ts";\nimport type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";\n')
s=s.replace('''  maxConcurrency?: number;\n}''','''  maxConcurrency?: number;\n  acquisition?: SecureAcquisitionService;\n}''')
s=s.replace('''        verifier: new BasicFileVerifier(),\n        options: { maxConcurrency: options.maxConcurrency }''','''        verifier: new BasicFileVerifier(),\n        capabilityCoordinator: new CapabilityCoordinator({ controller: this.controller, projections: this.projections, host: options.host, acquisition: options.acquisition }),\n        options: { maxConcurrency: options.maxConcurrency }''')
p.write_text(s)
PY

python3 - <<'PY'
from pathlib import Path
p=Path('src/runtime/orchestration/mission-orchestrator.ts')
s=p.read_text()
s=s.replace('import type { WorkItem } from "../../core/domain/work-item.ts";\n', 'import type { WorkItem } from "../../core/domain/work-item.ts";\nimport type { CapabilityDescriptor } from "../../core/domain/capability.ts";\n')
s=s.replace('import { HostAgentExecutionBackend, type HostAgentExecutionRequest } from "../../execution/host/host-agent-execution-backend.ts";\n', 'import { HostAgentExecutionBackend, type HostAgentExecutionRequest } from "../../execution/host/host-agent-execution-backend.ts";\nimport type { CapabilityCoordinator } from "./capability-coordinator.ts";\n')
s=s.replace('''  private readonly assurance: ArtifactAssurancePipeline;\n  private readonly running''','''  private readonly assurance: ArtifactAssurancePipeline;\n  private readonly capabilityCoordinator?: CapabilityCoordinator;\n  private readonly running''')
s=s.replace('''    contextCompiler?: ContextCompiler;\n    options?: MissionOrchestratorOptions;\n  }) {''','''    contextCompiler?: ContextCompiler;\n    capabilityCoordinator?: CapabilityCoordinator;\n    options?: MissionOrchestratorOptions;\n  }) {''')
s=s.replace('''    this.maxCyclesPerWake = Math.max(1, input.options?.maxCyclesPerWake ?? 64);\n    this.assurance''','''    this.maxCyclesPerWake = Math.max(1, input.options?.maxCyclesPerWake ?? 64);\n    this.capabilityCoordinator = input.capabilityCoordinator;\n    this.assurance''')
old='''      const batch = ready.slice(0, this.maxConcurrency);\n      await Promise.all(batch.map(work => this.executeWork(work)));'''
new='''      const dispatchable: Array<{ work: WorkItem; capabilities: CapabilityDescriptor[] }> = [];\n      for (const work of ready) {\n        if (dispatchable.length >= this.maxConcurrency) break;\n        if (work.purpose === "acquisition") { dispatchable.push({ work, capabilities: [] }); continue; }\n        const preparation = this.capabilityCoordinator ? await this.capabilityCoordinator.prepare(work) : { status: "ready" as const, capabilities: [], missingNeeds: [] };\n        if (preparation.status === "ready") dispatchable.push({ work, capabilities: preparation.capabilities });\n      }\n      if (dispatchable.length === 0) continue;\n      await Promise.all(dispatchable.map(item => this.executeWork(item.work, item.capabilities)));'''
if old not in s:
    raise SystemExit('orchestrator batch marker missing')
s=s.replace(old,new)
s=s.replace('''  private async executeWork(work: WorkItem): Promise<void> {\n    const state''','''  private async executeWork(work: WorkItem, capabilities: CapabilityDescriptor[] = []): Promise<void> {\n    if (work.purpose === "acquisition") {\n      await this.executeAcquisitionWork(work);\n      return;\n    }\n    const state''')
s=s.replace('''      capabilityRefs: []\n    });''','''      capabilityRefs: capabilities.map(capability => capability.id)\n    });''',1)
s=s.replace('''      expectedOutputs: work.expectedOutputs,\n      workspaceRoot: workspace.root,''','''      expectedOutputs: work.expectedOutputs,\n      capabilities,\n      workspaceRoot: workspace.root,''')
s=s.replace('''      capabilityRefs: [],\n      workspaceRoot: workspace.root,''','''      capabilityRefs: capabilities.map(capability => capability.id),\n      workspaceRoot: workspace.root,''')
marker='''  private async failWork(work: WorkItem, attemptId: string, reason: string): Promise<void> {'''
method='''  private async executeAcquisitionWork(work: WorkItem): Promise<void> {\n    const attemptId = `attempt-${work.id}-${randomUUID().slice(0, 8)}`;\n    const executionId = `execution-${work.id}-${randomUUID().slice(0, 8)}`;\n    await this.controller.emit(work.missionId, "attempt.created", { id: attemptId, workItemId: work.id, executorId: "capability-acquisition", contextPacketId: "internal" }, { type: "controller" }, `attempt:${attemptId}`);\n    await this.controller.emit(work.missionId, "work.started", { id: work.id }, { type: "controller" }, `work-started:${work.id}:${attemptId}`);\n    await this.controller.emit(work.missionId, "execution.created", { id: executionId, workItemId: work.id, attemptId, backend: "capability-acquisition" }, { type: "controller" }, `execution-created:${executionId}`);\n    await this.controller.emit(work.missionId, "execution.started", { id: executionId }, { type: "system" }, `execution-started:${executionId}`);\n    if (!this.capabilityCoordinator) {\n      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: "Capability acquisition service is not configured" }, { type: "system" }, `execution-settled:${executionId}`);\n      await this.failWork(work, attemptId, "Capability acquisition service is not configured");\n      return;\n    }\n    const outcome = await this.capabilityCoordinator.executeAcquisition(work);\n    if (!outcome.ok) {\n      await this.controller.emit(work.missionId, "execution.failed", { id: executionId, error: outcome.reason }, { type: "system" }, `execution-settled:${executionId}`);\n      await this.failWork(work, attemptId, outcome.reason);\n      return;\n    }\n    await this.controller.emit(work.missionId, "execution.completed", { id: executionId, capabilityRef: outcome.capability?.id }, { type: "system" }, `execution-settled:${executionId}`);\n    await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: "succeeded", capabilityRefs: outcome.capability ? [outcome.capability.id] : [] }, { type: "system" }, `attempt-completed:${attemptId}`);\n    await this.controller.emit(work.missionId, "work.completed", { id: work.id, summary: outcome.reason }, { type: "system" }, `work-completed:${work.id}:${attemptId}`);\n  }\n\n'''+marker
if marker not in s:
    raise SystemExit('orchestrator fail marker missing')
s=s.replace(marker,method)
p.write_text(s)
PY

cat > tests/unit/capability-materialization.test.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import { CapabilitySmokeTester } from "../../src/core/capabilities/sandbox/smoke-tester.ts";
import { SecureAcquisitionService } from "../../src/core/capabilities/secure-acquisition-service.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";

function createSkillRepo(root: string) {
  const repo = join(root, "skill-source");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "SKILL.md"), "# Fixture Skill\nUse this skill for special rendering.\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "SKILL.md"]);
  execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return { repo, sha: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() };
}

test("secure acquisition pins a Git candidate, structurally smokes an instruction skill and activates a mission-local immutable copy", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-"));
  const fixture = createSkillRepo(root);
  const overlay = new MissionCapabilityOverlay();
  const service = new SecureAcquisitionService({
    providers: [{ id: "fixture", async discover() { return [{ id: "candidate-1", sourceType: "github", sourceUri: fixture.repo, name: "fixture/special-render", description: "special rendering skill", candidateKind: "skill", status: "discovered" }]; } }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))),
    overlay,
    activationRoot: join(root, "mission-capabilities")
  });
  const traces: string[] = [];
  const outcome = await service.acquire({
    id: "need-1", missionId: "m1", objective: "special rendering", requiredFunctions: ["special rendering"], desiredInputs: [], desiredOutputs: [], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: [], gapRefs: [], status: "discovering"
  }, { onTrace(type) { traces.push(type); } });

  assert.ok(outcome.capability);
  assert.equal(outcome.capability.revision, fixture.sha);
  assert.match(outcome.capability.contentHash!, /^[0-9a-f]{64}$/);
  assert.equal(outcome.receipt.status, "activated");
  assert.equal(overlay.list("m1").length, 1);
  assert.ok(existsSync(outcome.capability.invocationRef!));
  assert.match(outcome.capability.invocationRef!, /SKILL\.md$/);
  assert.deepEqual(traces, [
    "capability.candidate.discovered",
    "capability.candidate.materialized",
    "capability.candidate.scanned",
    "capability.candidate.sandboxed",
    "capability.activated",
    "capability.acquisition.receipt"
  ]);
});
EOF

cat > tests/unit/agent-skill-selection.test.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ProcessManager } from "../../src/execution/local/process-manager.ts";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";

test("Git materializer selects the requested Agent Skill from a multi-skill repository", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-multiskill-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "skills", "alpha"), { recursive: true });
  mkdirSync(join(repo, "skills", "beta"), { recursive: true });
  writeFileSync(join(repo, "skills", "alpha", "SKILL.md"), "---\nname: alpha\n---\nAlpha\n");
  writeFileSync(join(repo, "skills", "beta", "SKILL.md"), "---\nname: beta\n---\nBeta\n");
  const pm = new ProcessManager();
  for (const args of [["init"], ["config", "user.email", "test@example.com"], ["config", "user.name", "Mission Test"], ["add", "."], ["commit", "-m", "fixture"]]) {
    const result = await pm.run({ command: "git", args, cwd: repo, env: { PATH: process.env.PATH ?? "" }, timeoutMs: 10_000 });
    assert.equal(result.exitCode, 0, result.stderr);
  }
  const materializer = new GitCandidateMaterializer(join(root, "quarantine"));
  const materialized = await materializer.materialize({
    id: "candidate-beta",
    sourceType: "agent-skill",
    sourceUri: repo,
    name: "beta",
    candidateKind: "skill",
    status: "discovered",
    metadata: { skillName: "beta" }
  });
  assert.equal(relative(materialized.root, join(materialized.root, "SKILL.md")), "SKILL.md");
  assert.match(materialized.root, /beta$/);
  assert.equal(materialized.candidate.metadata?.selectedSkillRoot, join("skills", "beta"));
});
EOF

cat > tests/unit/discovery-clients.test.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { AgentSkillsCliClient, parseAgentSkillsFindOutput } from "../../src/core/capabilities/providers/agent-skills-cli-client.ts";
import { GitHubRestSearchClient } from "../../src/core/capabilities/providers/github-rest-client.ts";

class FakeProcessManager {
  private readonly stdout: string;
  constructor(stdout: string) { this.stdout = stdout; }
  async run(spec: any) {
    assert.equal(spec.command, process.platform === "win32" ? "npx.cmd" : "npx");
    assert.deepEqual(spec.args.slice(0, 3), ["--yes", "skills@1.7.4", "find"]);
    assert.equal(spec.env.DISABLE_TELEMETRY, "1");
    return { exitCode: 0, stdout: this.stdout, stderr: "", timedOut: false };
  }
}

test("Agent Skills parser extracts repo@skill and direct tree results without treating prose as candidates", () => {
  const output = `\nFound skills:\n  vercel-labs/agent-skills@frontend-design\n  https://github.com/acme/skills/tree/main/skills/research-pro\nRun npx skills add ...\n`;
  const parsed = parseAgentSkillsFindOutput(output);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed.map(x => x.name).sort(), ["frontend-design", "research-pro"]);
  assert.equal(parsed.find(x => x.name === "frontend-design")?.sourceUri, "https://github.com/vercel-labs/agent-skills");
  assert.equal(parsed.find(x => x.name === "research-pro")?.sourceUri, "https://github.com/acme/skills/tree/main/skills/research-pro");
});

test("Agent Skills CLI client pins the package version used for discovery and does not install capabilities", async () => {
  const client = new AgentSkillsCliClient({ processManager: new FakeProcessManager("owner/repo@skill-one\n") as any });
  const result = await client.find("diagram animation", 5);
  assert.equal(result[0]?.name, "skill-one");
  assert.equal(client.packageVersion, "1.7.4");
});

test("GitHub REST client searches repository metadata with bounded result count and auth header", async () => {
  let requestedUrl = "";
  let authorization = "";
  const fakeFetch: typeof fetch = async (input, init) => {
    requestedUrl = String(input);
    authorization = new Headers(init?.headers).get("authorization") ?? "";
    return new Response(JSON.stringify({
      items: [
        { full_name: "owner/repo", description: "motion skill", html_url: "https://github.com/owner/repo", default_branch: "main", stargazers_count: 42 },
        { full_name: "owner/other", description: null, html_url: "https://github.com/owner/other", default_branch: "master", stargazers_count: 2 }
      ]
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const client = new GitHubRestSearchClient({ token: "secret", fetchImpl: fakeFetch });
  const result = await client.searchRepositories("svg animation", 1);
  assert.equal(result.length, 1);
  assert.equal(result[0]?.fullName, "owner/repo");
  assert.match(requestedUrl, /search\/repositories/);
  assert.match(requestedUrl, /per_page=1/);
  assert.equal(authorization, "Bearer secret");
});
EOF

cat > tests/e2e/capability-acquisition-orchestrator.test.ts <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MissionRuntime } from "../../src/runtime/mission-runtime.ts";
import { FakeHostAdapter } from "../../src/hosts/fake/fake-host-adapter.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { SecureAcquisitionService } from "../../src/core/capabilities/secure-acquisition-service.ts";
import { GitCandidateMaterializer } from "../../src/core/capabilities/materializer.ts";
import { CapabilitySmokeTester } from "../../src/core/capabilities/sandbox/smoke-tester.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";

function createSkillRepo(root: string) {
  const repo = join(root, "skill-source"); mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "fixture@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "SKILL.md"), "# Special Rendering\nProvides special rendering capability.\n", "utf8");
  execFileSync("git", ["-C", repo, "add", "SKILL.md"]); execFileSync("git", ["-C", repo, "commit", "-q", "-m", "fixture"]);
  return repo;
}

function provider(): DeliberationProvider {
  return {
    async interpretMission({ missionId, userGoal }) {
      const now = new Date().toISOString();
      return {
        missionSpec: { missionId, revision: 1, objective: userGoal, requestedOutputs: ["deliverable"], constraints: [], preferences: [], sourceRefs: [], createdAt: now },
        acceptanceContract: { missionId, revision: 1, requirements: [{ id: "R1", description: "deliverable exists", type: "functional", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }], requiredArtifacts: [{ logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }], requiredValidations: [{ id: "structural", description: "structural", level: "structural", requirementRefs: ["R1"] }], criticalFailureConditions: [], createdAt: now }
      };
    },
    async composeStrategy() { return { framing: "need-driven", approach: "acquire only when required", workstreams: [{ id: "delivery", objective: "deliver" }], revision: 1 }; },
    async planFrontier({ state }) {
      const now = new Date().toISOString();
      return {
        graphRevision: state.graphRevision + 1,
        capabilityNeeds: [{ id: "need-special", missionId: state.missionId, objective: "special rendering", requiredFunctions: ["special rendering"], desiredInputs: [], desiredOutputs: [], purpose: "production", urgency: "blocking", acquisitionAllowed: true, maxRisk: "medium", requirementRefs: ["R1"], gapRefs: [], status: "checking-installed" }],
        workItems: [{ id: "produce", missionId: state.missionId, workstreamId: "delivery", purpose: "production", objective: "produce requested document with special rendering capability", status: "ready", requirementRefs: ["R1"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [{ logicalName: "deliverable", type: "document", required: true }], localAcceptanceCriteria: [], capabilityNeedRefs: ["need-special"], priority: 90, graphRevision: state.graphRevision + 1, createdBy: "planner", createdAt: now, updatedAt: now }]
      };
    },
    async diagnoseGap({ gap }) { return { gapId: gap.id, rootCause: gap.description, intervention: "revise_work", confidence: 1 }; },
    async challengeCompletion() { return { blockingObjection: false, objections: [], confidence: 1 }; }
  };
}

test("missing capability becomes acquisition work, activates mission-locally, unblocks original work and completes acceptance", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-capability-e2e-"));
  const repo = createSkillRepo(root);
  let workerCapabilityRefs: string[] = [];
  const host = new FakeHostAdapter([], {
    agentResponder(request) {
      workerCapabilityRefs = request.allowedCapabilityRefs;
      const capabilities = (request.context as any).capabilities ?? [];
      assert.equal(capabilities.length, 1);
      writeFileSync(join(request.workspaceRoot!, "deliverable.txt"), "rendered with acquired capability\n", "utf8");
      return { text: JSON.stringify({ status: "completed", summary: "done", outputs: [{ path: "deliverable.txt", logicalName: "deliverable", type: "document", requirementRefs: ["R1"] }], proposedFacts: [], proposedWork: [], warnings: [] }) };
    }
  });
  const overlay = new MissionCapabilityOverlay();
  const acquisition = new SecureAcquisitionService({
    providers: [{ id: "fixture", async discover() { return [{ id: "candidate-special", sourceType: "github", sourceUri: repo, name: "fixture/special-render", description: "special rendering skill", candidateKind: "skill", status: "discovered" }]; } }],
    materializer: new GitCandidateMaterializer(join(root, "quarantine")),
    smoke: new CapabilitySmokeTester(new SandboxManager(join(root, "sandboxes"))), overlay,
    activationRoot: join(root, "capabilities")
  });
  const runtime = new MissionRuntime({ rootDir: join(root, "runtime"), host, deliberation: provider(), acquisition });
  await runtime.controller.createMission("m-cap", "produce a deliverable requiring a missing capability");
  await runtime.orchestrator!.runUntilQuiescent("m-cap");

  const state = await runtime.controller.state("m-cap");
  assert.equal(state.status, "completed");
  assert.equal(workerCapabilityRefs.length, 1);
  const needs = await runtime.projections.listCapabilityNeeds("m-cap");
  assert.equal(needs[0]?.status, "available");
  assert.equal(needs[0]?.resolvedCapabilityRef, workerCapabilityRefs[0]);
  const capabilities = await runtime.projections.listCapabilities("m-cap");
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities[0]?.scope, "mission");
  const receipts = await runtime.projections.listAcquisitionReceipts("m-cap");
  assert.equal(receipts[0]?.status, "activated");
  const events = await runtime.events.list("m-cap");
  assert.ok(events.some(e => e.type === "capability.candidate.materialized"));
  assert.ok(events.some(e => e.type === "capability.candidate.scanned"));
  assert.ok(events.some(e => e.type === "capability.candidate.sandboxed"));
  assert.ok(events.some(e => e.type === "capability.activated"));
  assert.ok(events.some(e => e.type === "work.blocked" && (e.payload as any).id === "produce"));
  assert.ok(events.some(e => e.type === "work.updated" && (e.payload as any).id === "produce" && (e.payload as any).status === "ready"));
  runtime.close();
});
EOF

chmod +x scripts/recover-capability-routing.sh
