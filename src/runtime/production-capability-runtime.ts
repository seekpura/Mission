import { join, resolve } from "node:path";
import type { CapabilityCandidate, CapabilityNeed } from "../core/domain/capability.ts";
import type { CapabilityDiscoveryProvider } from "../core/capabilities/discovery-provider.ts";
import { CandidateRanker, type RankedCandidate } from "../core/capabilities/candidate-ranker.ts";
import {
  CapabilityCoordinator,
  type CapabilityCandidateDiscovery,
  type CapabilityRuntime,
  type HostCapabilitySource
} from "../core/capabilities/capability-coordinator.ts";
import { CapabilityAcquisitionTransaction } from "../core/capabilities/acquisition-transaction.ts";
import { FileAcquisitionReceiptStore } from "../core/capabilities/acquisition-receipt.ts";
import { RepositoryCapabilityMaterializer } from "../core/capabilities/materialization.ts";
import { MissionLocalDirectoryActivator } from "../core/capabilities/mission-local-directory-activator.ts";
import { MissionCapabilityOverlay } from "../core/capabilities/mission-capability-overlay.ts";
import { AgentSkillsDiscoveryProvider } from "../core/capabilities/providers/agent-skills-provider.ts";
import { GitHubCapabilityDiscoveryProvider } from "../core/capabilities/providers/github-provider.ts";
import { SandboxManager } from "../core/capabilities/sandbox/sandbox-manager.ts";
import { IsolatedCapabilitySmokeRunner } from "../core/capabilities/sandbox/isolated-smoke-runner.ts";
import type { HostAdapter } from "../hosts/deepseek/host-adapter.ts";
import type { RuntimeApprovalManager } from "./approval-manager.ts";
import { AgentSkillSmokePlanResolver, DockerSmokeExecutor } from "./agent-skill-runtime.ts";
import { GitHubCapabilityClient } from "./github-capability-client.ts";

export interface ProductionCapabilityRuntimeOptions {
  rootDir: string;
  host: HostAdapter;
  overlay: MissionCapabilityOverlay;
  approvals: RuntimeApprovalManager;
  githubToken?: string;
  dockerImage: string;
  dockerBinary?: string;
  githubRequestTimeoutMs?: number;
  maxCandidates?: number;
}

export function createProductionAgentSkillCapabilityRuntime(
  options: ProductionCapabilityRuntimeOptions
): CapabilityRuntime {
  const root = resolve(options.rootDir);
  const github = new GitHubCapabilityClient({
    token: options.githubToken,
    requestTimeoutMs: options.githubRequestTimeoutMs
  });
  const providers: CapabilityDiscoveryProvider[] = [
    new AgentSkillsDiscoveryProvider(github),
    new GitHubCapabilityDiscoveryProvider(github)
  ];
  const discovery = new SkillOnlyRankedDiscovery(providers);
  const materializer = new RepositoryCapabilityMaterializer({
    stagingRoot: join(root, "staging"),
    client: github
  });
  const transaction = new CapabilityAcquisitionTransaction({
    materializer,
    sandboxManager: new SandboxManager(join(root, "sandboxes")),
    smokeRunner: new IsolatedCapabilitySmokeRunner(
      new DockerSmokeExecutor({
        image: options.dockerImage,
        binary: options.dockerBinary
      }),
      new AgentSkillSmokePlanResolver()
    ),
    activator: new MissionLocalDirectoryActivator(join(root, "activated")),
    overlay: options.overlay,
    receiptStore: new FileAcquisitionReceiptStore(join(root, "receipts")),
    approvalBroker: options.approvals
  });
  const hostCapabilities: HostCapabilitySource = {
    async listHostCapabilities() {
      return (await options.host.snapshotEnvironment()).capabilities;
    }
  };

  return new CapabilityCoordinator({
    hostCapabilities,
    overlay: options.overlay,
    discovery,
    acquirer: transaction,
    maxCandidates: options.maxCandidates ?? 4
  });
}

class SkillOnlyRankedDiscovery implements CapabilityCandidateDiscovery {
  private readonly providers: CapabilityDiscoveryProvider[];
  private readonly ranker = new CandidateRanker();

  constructor(providers: CapabilityDiscoveryProvider[]) {
    this.providers = providers;
  }

  async discover(need: CapabilityNeed): Promise<RankedCandidate[]> {
    const settled = await Promise.allSettled(this.providers.map(provider => provider.discover(need)));
    const successful = settled.filter((item): item is PromiseFulfilledResult<CapabilityCandidate[]> => item.status === "fulfilled");
    if (successful.length === 0) {
      const reasons = settled
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map(item => item.reason instanceof Error ? item.reason.message : String(item.reason));
      throw new Error(`All Agent Skill discovery providers failed: ${reasons.join(" | ")}`);
    }

    const deduped = new Map<string, CapabilityCandidate>();
    for (const result of successful) {
      for (const candidate of result.value) {
        if (candidate.candidateKind !== "skill") continue;
        if (candidate.sourceType !== "agent-skill" && candidate.sourceType !== "github") continue;
        deduped.set(`${candidate.sourceType}:${candidate.sourceUri}`, candidate);
      }
    }
    return this.ranker.rank(need, [...deduped.values()]);
  }
}
