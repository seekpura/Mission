import type { DeliberationProvider, StrategyProposal, FrontierProposal, GapDiagnosis, CompletionChallenge } from "./deliberation-provider.ts";

export class DeterministicDeliberationProvider implements DeliberationProvider {
  async composeStrategy(input: any): Promise<StrategyProposal> {
    return { framing: input.userGoal, approach: "progressive", workstreams: [], revision: 1 };
  }
  async planFrontier(input: any): Promise<FrontierProposal> {
    return { workItems: [], graphRevision: input.state.graphRevision + 1 };
  }
  async diagnoseGap(input: any): Promise<GapDiagnosis> {
    return { gapId: input.gap.id, rootCause: input.gap.description, intervention: "revise_work", confidence: 0.8 };
  }
  async challengeCompletion(): Promise<CompletionChallenge> {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}
