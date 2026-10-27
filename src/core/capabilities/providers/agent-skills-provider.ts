import { randomUUID } from "node:crypto";
import type { CapabilityCandidate, CapabilityNeed } from "../../domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "../discovery-provider.ts";

export interface AgentSkillsSearchResult {
  name: string;
  sourceUri: string;
  description?: string;
  revision?: string;
}

export interface AgentSkillsClient {
  find(query: string, limit: number): Promise<AgentSkillsSearchResult[]>;
}

export class AgentSkillsDiscoveryProvider implements CapabilityDiscoveryProvider {
  id = "agent-skills";
  private readonly client: AgentSkillsClient;
  constructor(client: AgentSkillsClient) { this.client = client; }

  async discover(need: CapabilityNeed): Promise<CapabilityCandidate[]> {
    const query = [need.requiredFunctions.join(" "), need.desiredOutputs.join(" ")].filter(Boolean).join(" ");
    const results = await this.client.find(query, 8);
    return results.map(result => ({
      id: randomUUID(),
      sourceType: "agent-skill",
      sourceUri: result.sourceUri,
      name: result.name,
      description: result.description,
      candidateKind: "skill",
      resolvedRevision: result.revision,
      status: "discovered"
    }));
  }
}
