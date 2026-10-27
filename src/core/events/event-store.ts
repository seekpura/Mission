import type { MissionEvent } from "../domain/event.ts";

export interface EventStore {
  append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>>;
  list(missionId: string, afterSequence?: number): Promise<MissionEvent[]>;
  lastSequence(missionId: string): Promise<number>;
}
