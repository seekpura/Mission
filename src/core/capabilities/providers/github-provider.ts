import { randomUUID } from "node:crypto";
import type { CapabilityCandidate, CapabilityNeed } from "../../domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "../discovery-provider.ts";

export interface GitHubRepositorySummary {
  fullName: string;
  description?: string;
  url: string;
  defaultBranch?: string;
  stars?: number;
}

export interface GitHubSearchClient {
  searchRepositories(query: string, limit: number): Promise<GitHubRepositorySummary[]>;
}

export class GitHubCapabilityDiscoveryProvider implements CapabilityDiscoveryProvider {
  id = "github";
  private readonly client: GitHubSearchClient;

  constructor(client: GitHubSearchClient) { this.client = client; }

  async discover(need: CapabilityNeed): Promise<CapabilityCandidate[]> {
    const query = buildQuery(need);
    const repos = await this.client.searchRepositories(query, 8);
    return repos.map(repo => ({
      id: randomUUID(),
      sourceType: "github",
      sourceUri: repo.url,
      name: repo.fullName,
      description: repo.description,
      candidateKind: inferKind(`${repo.fullName} ${repo.description ?? ""}`),
      status: "discovered"
    }));
  }
}

function buildQuery(need: CapabilityNeed) {
  const core = need.requiredFunctions.join(" ").trim();
  const outputs = need.desiredOutputs.join(" ").trim();
  return [core, outputs].filter(Boolean).join(" ");
}

function inferKind(text: string): CapabilityCandidate["candidateKind"] {
  const t = text.toLowerCase();
  if (t.includes("mcp")) return "mcp";
  if (t.includes("skill")) return "skill";
  if (t.includes("cli")) return "cli";
  if (t.includes("agent")) return "agent";
  if (t.includes("plugin")) return "workflow";
  return "library";
}
