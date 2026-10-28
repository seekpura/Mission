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
