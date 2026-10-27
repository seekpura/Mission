import type { MissionEvent } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";

export interface MissionProjectionReader {
  getMissionState(missionId: string): Promise<MissionState | null>;
  listWorkItems(missionId: string): Promise<WorkItem[]>;
  listGaps(missionId: string): Promise<Gap[]>;
}

export interface MissionProjectionWriter {
  apply(event: MissionEvent): void;
  rebuild(missionId: string, events: MissionEvent[]): void;
}
