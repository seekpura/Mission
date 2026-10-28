import type { MissionState } from "../core/domain/mission.ts";
import type { EventStore } from "../core/events/event-store.ts";
import type { ControllerCycleInput } from "../core/mission/controller.ts";
import { MissionController } from "../core/mission/controller.ts";

export interface MissionSupervisorOptions {
  maxCyclesPerWake?: number;
}

export type MissionUpdateListener = (missionId: string, state: MissionState) => void | Promise<void>;
export type MissionErrorListener = (missionId: string, error: Error) => void | Promise<void>;

export class MissionSupervisor {
  private readonly controller: MissionController;
  private readonly events: EventStore;
  private readonly maxCyclesPerWake: number;
  private readonly running = new Map<string, Promise<void>>();
  private readonly pendingTriggers = new Map<string, ControllerCycleInput["trigger"]>();
  private readonly updateListeners = new Set<MissionUpdateListener>();
  private readonly errorListeners = new Set<MissionErrorListener>();
  private draining = false;

  constructor(controller: MissionController, events: EventStore, options: MissionSupervisorOptions = {}) {
    this.controller = controller;
    this.events = events;
    this.maxCyclesPerWake = Math.max(1, options.maxCyclesPerWake ?? 32);
  }

  onUpdate(listener: MissionUpdateListener): () => void {
    this.updateListeners.add(listener);
    return () => this.updateListeners.delete(listener);
  }

  onError(listener: MissionErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  wake(missionId: string, trigger: ControllerCycleInput["trigger"] = "manual"): Promise<void> {
    if (this.draining) return Promise.resolve();
    this.pendingTriggers.set(missionId, trigger);
    const existing = this.running.get(missionId);
    if (existing) return existing;

    const task = this.drive(missionId)
      .catch(async error => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        await this.publishError(missionId, normalized);
      })
      .finally(() => {
        this.running.delete(missionId);
        if (!this.draining && this.pendingTriggers.has(missionId)) {
          void this.wake(missionId, this.pendingTriggers.get(missionId));
        }
      });
    this.running.set(missionId, task);
    return task;
  }

  beginDrain(): void {
    if (this.draining) return;
    this.draining = true;
    this.pendingTriggers.clear();
  }

  isDraining(): boolean {
    return this.draining;
  }

  activeMissionIds(): string[] {
    return [...this.running.keys()].sort();
  }

  async waitForIdle(missionId: string): Promise<void> {
    for (;;) {
      const current = this.running.get(missionId);
      if (!current) return;
      await current;
      if (!this.running.has(missionId) && (this.draining || !this.pendingTriggers.has(missionId))) return;
    }
  }

  async waitForAllIdle(): Promise<void> {
    for (;;) {
      const current = [...this.running.values()];
      if (current.length === 0) return;
      await Promise.all(current);
      if (this.running.size === 0) return;
    }
  }

  isRunning(missionId: string): boolean {
    return this.running.has(missionId);
  }

  private async drive(missionId: string): Promise<void> {
    while (!this.draining && this.pendingTriggers.has(missionId)) {
      const trigger = this.pendingTriggers.get(missionId) ?? "manual";
      this.pendingTriggers.delete(missionId);
      await this.drain(missionId, trigger);
    }
  }

  private async drain(missionId: string, initialTrigger: ControllerCycleInput["trigger"]): Promise<void> {
    let trigger = initialTrigger;
    for (let cycle = 0; cycle < this.maxCyclesPerWake; cycle += 1) {
      if (this.draining) return;
      const before = await this.events.lastSequence(missionId);
      const beforeState = await this.controller.state(missionId);
      if (isTerminal(beforeState.status)) {
        await this.publishUpdate(missionId, beforeState);
        return;
      }

      await this.controller.runControllerCycle({ missionId, trigger });
      const after = await this.events.lastSequence(missionId);
      const state = await this.controller.state(missionId);
      await this.publishUpdate(missionId, state);

      // Shutdown waits for the currently executing controller cycle to reach
      // this durable boundary, but never admits another cycle afterward.
      if (this.draining) return;
      if (isTerminal(state.status)) return;
      if (after === before) return;
      if (state.pendingApprovalIds.length > 0) return;
      trigger = "execution_event";
    }

    throw new Error(`Mission supervisor exceeded ${this.maxCyclesPerWake} cycles without reaching quiescence`);
  }

  private async publishUpdate(missionId: string, state: MissionState): Promise<void> {
    await Promise.all([...this.updateListeners].map(listener => Promise.resolve(listener(missionId, state))));
  }

  private async publishError(missionId: string, error: Error): Promise<void> {
    if (this.errorListeners.size === 0) {
      console.error(`[MissionSupervisor] ${missionId}: ${error.stack ?? error.message}`);
      return;
    }
    await Promise.all([...this.errorListeners].map(listener => Promise.resolve(listener(missionId, error))));
  }
}

function isTerminal(status: MissionState["status"]): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}
