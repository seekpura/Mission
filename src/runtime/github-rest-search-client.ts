import type { GitHubRepositorySummary, GitHubSearchClient } from "../core/capabilities/providers/github-provider.ts";

export interface GitHubRestSearchClientOptions {
  token?: string;
  apiBase?: string;
  userAgent?: string;
  fetchImpl?: typeof fetch;
}

export class GitHubRestSearchClient implements GitHubSearchClient {
  private readonly token?: string;
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GitHubRestSearchClientOptions = {}) {
    this.token = options.token?.trim() || undefined;
    this.apiBase = normalizeApiBase(options.apiBase ?? "https://api.github.com");
    this.userAgent = options.userAgent?.trim() || "mission-runtime";
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async searchRepositories(query: string, limit: number): Promise<GitHubRepositorySummary[]> {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const perPage = Math.min(25, Math.max(1, Math.trunc(limit)));
    const url = new URL("/search/repositories", `${this.apiBase}/`);
    url.searchParams.set("q", `${trimmed} fork:false archived:false`);
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", String(perPage));

    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": this.userAgent,
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {})
      }
    });
    if (!response.ok) {
      const body = await boundedText(response, 8_192);
      throw new Error(`GitHub repository search failed (${response.status}): ${body || response.statusText}`);
    }

    const payload = await response.json() as { items?: unknown };
    if (!Array.isArray(payload.items)) throw new Error("GitHub repository search returned an invalid items payload");

    return payload.items
      .map(parseRepository)
      .filter((value): value is GitHubRepositorySummary => value !== null)
      .slice(0, perPage);
  }
}

function parseRepository(value: unknown): GitHubRepositorySummary | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.full_name !== "string" || typeof record.html_url !== "string") return null;
  const source = canonicalGitHubRepositoryUrl(record.html_url);
  if (!source) return null;
  return {
    fullName: record.full_name,
    url: source,
    ...(typeof record.description === "string" && record.description.trim() ? { description: record.description } : {}),
    ...(typeof record.default_branch === "string" && record.default_branch.trim() ? { defaultBranch: record.default_branch } : {}),
    ...(typeof record.stargazers_count === "number" && Number.isFinite(record.stargazers_count)
      ? { stars: record.stargazers_count }
      : {})
  };
}

function canonicalGitHubRepositoryUrl(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com" || url.username || url.password || url.port) return null;
  if (url.search || url.hash) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const owner = safeRepoSegment(parts[0]!);
  const repo = safeRepoSegment(parts[1]!.replace(/\.git$/i, ""));
  if (!owner || !repo) return null;
  return `https://github.com/${owner}/${repo}`;
}

function safeRepoSegment(value: string): string | null {
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
}

function normalizeApiBase(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("GitHub API base must use HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("GitHub API base must not contain credentials, query, or fragment");
  return url.toString().replace(/\/$/, "");
}

async function boundedText(response: Response, maxBytes: number): Promise<string> {
  const text = await response.text();
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  return bytes.subarray(0, maxBytes).toString("utf8");
}
