import type { MissionState } from "../domain/mission.ts";
import type { StrategyProposal } from "../planning/deliberation-provider.ts";
import type { MissionJournalView } from "./journal-view.ts";

export interface MissionReadModelReader {
  state(missionId: string): Promise<MissionState>;
  journal(missionId: string): Promise<MissionJournalView>;
  latestStrategy(missionId: string): Promise<StrategyProposal | undefined>;
}
