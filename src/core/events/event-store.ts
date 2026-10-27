import type { MissionEvent } from "../domain/event.ts";

export class OptimisticConcurrencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimisticConcurrencyError";
  }
}

export interface EventStore {
  append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>>;
  list(missionId: string, afterSequence?: number): Promise<MissionEvent[]>;
  lastSequence(missionId: string): Promise<number>;
}
