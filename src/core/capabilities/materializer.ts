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
