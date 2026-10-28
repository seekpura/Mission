import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type {
  AgentSkillsClient,
  AgentSkillsSearchResult
} from "../core/capabilities/providers/agent-skills-provider.ts";
import type {
  GitHubRepositorySummary,
  GitHubSearchClient
} from "../core/capabilities/providers/github-provider.ts";
import type { RepositorySnapshotClient } from "../core/capabilities/materialization.ts";

export interface GitHubCapabilityClientOptions {
  token?: string;
  apiBaseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxBlobBytes?: number;
}

interface GitHubRepositoryResponse {
  full_name: string;
  description?: string | null;
  html_url: string;
  default_branch: string;
  stargazers_count?: number;
}

interface GitHubCommitResponse {
  sha: string;
  commit?: { tree?: { sha?: string } };
}

interface GitHubTreeEntry {
  path?: string;
  mode?: string;
  type?: "blob" | "tree" | "commit" | string;
  sha?: string;
  size?: number;
}

interface GitHubTreeResponse {
  truncated?: boolean;
  tree?: GitHubTreeEntry[];
}

interface GitHubBlobResponse {
  encoding?: string;
  content?: string;
  size?: number;
}

export class GitHubCapabilityClient implements GitHubSearchClient, RepositorySnapshotClient, AgentSkillsClient {
  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly maxBlobBytes: number;

  constructor(options: GitHubCapabilityClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.apiBaseUrl = normalizeApiBase(options.apiBaseUrl ?? "https://api.github.com");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = Math.max(1_000, options.requestTimeoutMs ?? 20_000);
    this.maxFiles = Math.max(1, options.maxFiles ?? 2_000);
    this.maxTotalBytes = Math.max(1_024, options.maxTotalBytes ?? 25 * 1024 * 1024);
    this.maxBlobBytes = Math.max(1_024, options.maxBlobBytes ?? 2 * 1024 * 1024);
  }

  async searchRepositories(query: string, limit: number): Promise<GitHubRepositorySummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const capped = clampLimit(limit, 1, 50);
    const response = await this.getJson<{ items?: GitHubRepositoryResponse[] }>(
      `/search/repositories?q=${encodeURIComponent(trimmed)}&per_page=${capped}`
    );
    return (response.items ?? []).slice(0, capped).map(repo => ({
      fullName: repo.full_name,
      ...(repo.description ? { description: repo.description } : {}),
      url: repo.html_url,
      defaultBranch: repo.default_branch,
      stars: repo.stargazers_count ?? 0
    }));
  }

  async find(query: string, limit: number): Promise<AgentSkillsSearchResult[]> {
    if (!this.token) return [];
    const trimmed = query.trim();
    const capped = clampLimit(limit, 1, 30);
    const search = ["filename:SKILL.md", trimmed].filter(Boolean).join(" ");
    const response = await this.getJson<{
      items?: Array<{
        path?: string;
        repository?: { full_name?: string; html_url?: string };
      }>;
    }>(`/search/code?q=${encodeURIComponent(search)}&per_page=${capped}`);

    const deduped = new Map<string, AgentSkillsSearchResult>();
    for (const item of response.items ?? []) {
      const fullName = item.repository?.full_name;
      const sourceUri = item.repository?.html_url;
      if (!fullName || !sourceUri || deduped.has(sourceUri)) continue;
      deduped.set(sourceUri, {
        name: fullName,
        sourceUri,
        description: item.path ? `Agent Skill discovered from ${item.path}` : "Agent Skill repository discovered by GitHub code search"
      });
      if (deduped.size >= capped) break;
    }
    return [...deduped.values()];
  }

  async snapshot(input: {
    sourceUri: string;
    targetDirectory: string;
    requestedRevision?: string;
  }): Promise<{ resolvedRevision: string }> {
    const repo = parseGitHubRepositoryUri(input.sourceUri);
    const targetRoot = resolve(input.targetDirectory);
    await mkdir(targetRoot, { recursive: true });
    const existing = await readdir(targetRoot);
    if (existing.length > 0) {
      throw new Error(`GitHub snapshot target must be empty: ${targetRoot}`);
    }

    const metadata = await this.getJson<GitHubRepositoryResponse>(`/repos/${repo.owner}/${repo.repo}`);
    const requested = input.requestedRevision?.trim() || metadata.default_branch;
    if (!requested) throw new Error(`GitHub repository has no default branch: ${repo.owner}/${repo.repo}`);

    const commit = await this.getJson<GitHubCommitResponse>(
      `/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(requested)}`
    );
    const commitSha = requireSha(commit.sha, "commit");
    const treeSha = requireSha(commit.commit?.tree?.sha, "commit tree");
    const tree = await this.getJson<GitHubTreeResponse>(
      `/repos/${repo.owner}/${repo.repo}/git/trees/${treeSha}?recursive=1`
    );
    if (tree.truncated) {
      throw new Error(`GitHub recursive tree is truncated; refusing incomplete capability snapshot: ${repo.owner}/${repo.repo}@${commitSha}`);
    }

    const entries = normalizeTree(tree.tree ?? []);
    const blobs = entries.filter(entry => entry.type === "blob");
    if (blobs.length > this.maxFiles) {
      throw new Error(`GitHub capability snapshot exceeds file limit ${this.maxFiles}: ${blobs.length}`);
    }
    let totalBytes = 0;
    for (const entry of blobs) {
      if (entry.size > this.maxBlobBytes) {
        throw new Error(`GitHub capability blob exceeds ${this.maxBlobBytes} bytes: ${entry.path}`);
      }
      totalBytes += entry.size;
      if (totalBytes > this.maxTotalBytes) {
        throw new Error(`GitHub capability snapshot exceeds total byte limit ${this.maxTotalBytes}`);
      }
    }

    for (const entry of entries) {
      if (entry.type === "tree") continue;
      const destination = safeDestination(targetRoot, entry.path);
      await mkdir(dirname(destination), { recursive: true });
      const blob = await this.getJson<GitHubBlobResponse>(
        `/repos/${repo.owner}/${repo.repo}/git/blobs/${entry.sha}`
      );
      if (blob.encoding !== "base64" || typeof blob.content !== "string") {
        throw new Error(`Unsupported GitHub blob encoding for ${entry.path}: ${String(blob.encoding)}`);
      }
      const bytes = Buffer.from(blob.content.replace(/\s+/g, ""), "base64");
      if (bytes.length > this.maxBlobBytes) {
        throw new Error(`Downloaded GitHub blob exceeds ${this.maxBlobBytes} bytes: ${entry.path}`);
      }
      if (entry.size !== bytes.length || (typeof blob.size === "number" && blob.size !== bytes.length)) {
        throw new Error(`GitHub blob size mismatch for ${entry.path}`);
      }

      if (entry.mode === "120000") {
        const linkTarget = bytes.toString("utf8");
        validateSymlinkTarget(targetRoot, destination, linkTarget, entry.path);
        await symlink(linkTarget, destination);
        continue;
      }

      await writeFile(destination, bytes, { mode: entry.mode === "100755" ? 0o755 : 0o644 });
      if (entry.mode === "100755") await chmod(destination, 0o755);
    }

    return { resolvedRevision: commitSha };
  }

  private async getJson<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
        method: "GET",
        signal: controller.signal,
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "mission-runtime-capability-transport",
          ...(this.token ? { authorization: `Bearer ${this.token}` } : {})
        }
      });
      if (!response.ok) {
        const body = (await response.text()).slice(0, 2_048);
        const remaining = response.headers.get("x-ratelimit-remaining");
        const reset = response.headers.get("x-ratelimit-reset");
        const rate = remaining === "0" ? ` GitHub rate limit exhausted${reset ? ` until ${reset}` : ""}.` : "";
        throw new Error(`GitHub API ${response.status} for ${path}.${rate}${body ? ` ${body}` : ""}`);
      }
      return await response.json() as T;
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`GitHub API request timed out after ${this.requestTimeoutMs}ms: ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

interface NormalizedTreeEntry {
  path: string;
  mode: "100644" | "100755" | "120000" | "040000";
  type: "blob" | "tree";
  sha: string;
  size: number;
}

function normalizeTree(entries: GitHubTreeEntry[]): NormalizedTreeEntry[] {
  return entries.map((entry, index) => {
    const path = requireRepositoryPath(entry.path, `tree[${index}].path`);
    const sha = requireSha(entry.sha, `tree[${index}].sha`);
    if (entry.type === "commit") {
      throw new Error(`GitHub capability snapshot contains a submodule, which is not materialized automatically: ${path}`);
    }
    if (entry.type !== "blob" && entry.type !== "tree") {
      throw new Error(`Unsupported GitHub tree entry type ${String(entry.type)} at ${path}`);
    }
    const mode = normalizeMode(entry.mode, entry.type, path);
    const size = entry.type === "blob" ? requireSize(entry.size, path) : 0;
    return { path, sha, type: entry.type, mode, size };
  }).sort((a, b) => a.path.localeCompare(b.path));
}

function normalizeMode(value: string | undefined, type: "blob" | "tree", path: string): NormalizedTreeEntry["mode"] {
  if (type === "tree") {
    if (value !== "040000" && value !== "40000") throw new Error(`Unsupported Git tree mode ${String(value)} at ${path}`);
    return "040000";
  }
  if (value === "100644" || value === "100755" || value === "120000") return value;
  throw new Error(`Unsupported Git blob mode ${String(value)} at ${path}`);
}

function requireRepositoryPath(value: string | undefined, label: string): string {
  if (!value || value.length > 4_096 || value.includes("\0") || value.includes("\\") || value.startsWith("/")) {
    throw new Error(`Invalid GitHub repository path at ${label}`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe GitHub repository path at ${label}: ${value}`);
  }
  return value;
}

function safeDestination(root: string, repositoryPath: string): string {
  const destination = resolve(root, ...repositoryPath.split("/"));
  assertWithin(root, destination, repositoryPath);
  return destination;
}

function validateSymlinkTarget(root: string, destination: string, target: string, label: string): void {
  if (!target || target.includes("\0") || isAbsolute(target)) {
    throw new Error(`Unsafe absolute/empty symlink target in GitHub capability snapshot: ${label}`);
  }
  const resolvedTarget = resolve(dirname(destination), target);
  assertWithin(root, resolvedTarget, label);
}

function assertWithin(root: string, candidate: string, label: string): void {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel !== "" && (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error(`GitHub capability snapshot path escapes target root: ${label}`);
  }
}

function parseGitHubRepositoryUri(value: string): { owner: string; repo: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`Invalid GitHub repository URL: ${value}`); }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.search || url.hash) {
    throw new Error(`Only canonical https://github.com/<owner>/<repo> repository URLs are allowed: ${value}`);
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) throw new Error(`GitHub source must identify one repository: ${value}`);
  const owner = safeRepositorySegment(parts[0]!, "owner");
  const repo = safeRepositorySegment(parts[1]!.replace(/\.git$/i, ""), "repo");
  return { owner, repo };
}

function safeRepositorySegment(value: string, label: string): string {
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`Invalid GitHub ${label}: ${value}`);
  return value;
}

function requireSha(value: string | undefined, label: string): string {
  if (!value || !/^[0-9a-f]{40}$/i.test(value)) throw new Error(`Invalid GitHub ${label} SHA: ${String(value)}`);
  return value.toLowerCase();
}

function requireSize(value: number | undefined, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid GitHub blob size for ${path}`);
  }
  return value;
}

function clampLimit(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeApiBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`GitHub API base must use https: ${value}`);
  return url.toString().replace(/\/$/, "");
}
