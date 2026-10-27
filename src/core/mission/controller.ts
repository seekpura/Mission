import { randomUUID } from "node:crypto";
import type { EventStore } from "../events/event-store.ts";
import { projectMissionState } from "../events/state-projector.ts";
import type { MissionEventType } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";

export interface ControllerCycleInput {
  missionId: string;
  trigger: "mission_created" | "user_steering" | "execution_event" | "verification_event" | "approval_event" | "retry_timer" | "manual";
}

export interface ControllerCycleResult {
  missionRevision: number;
  decisionsCreated: string[];
  workItemsCreated: string[];
  executionsDispatched: string[];
  verificationsScheduled: string[];
  status: MissionState["status"];
}

export class MissionController {
  private readonly store: EventStore;
  constructor(store: EventStore) { this.store = store; }

  async emit(
    missionId: string,
    type: MissionEventType,
    payload: unknown,
    actor: { type: "user" | "controller" | "planner" | "worker" | "verifier" | "host" | "system"; id?: string } = { type: "controller" },
    idempotencyKey?: string
  ) {
    const expected = await this.store.lastSequence(missionId);
    return this.store.append({
      id: randomUUID(),
      missionId,
      type,
      actor,
      payload,
      idempotencyKey,
      schemaVersion: 1,
      createdAt: new Date().toISOString()
    }, expected);
  }

  async createMission(missionId: string, userGoal: string) {
    if (await this.store.lastSequence(missionId) > 0) return this.state(missionId);
    await this.emit(missionId, "mission.created", { missionId, userGoal }, { type: "user" }, `mission-created:${missionId}`);
    await this.emit(missionId, "mission.spec.revised", { revision: 1, objective: userGoal });
    await this.emit(missionId, "acceptance.created", { revision: 1 });
    return this.state(missionId);
  }

  async proposeWork(work: WorkItem) {
    const hasReason = work.purpose === "exploration" || work.requirementRefs.length > 0 || work.gapRefs.length > 0 || work.inputArtifactRefs.length > 0 || work.capabilityNeedRefs.length > 0;
    if (!hasReason) throw new Error(`Orphan work item rejected: ${work.id}`);
    await this.emit(work.missionId, "work.created", { id: work.id, status: work.status, workstreamId: work.workstreamId, work });
  }

  async steer(missionId: string, message: string) {
    await this.emit(missionId, "user.steering.received", { message }, { type: "user" });
    return this.state(missionId);
  }

  async openGap(missionId: string, payload: { id: string; severity: "critical" | "major" | "minor"; description: string; blocking?: boolean }) {
    await this.emit(missionId, "gap.opened", payload, { type: "verifier" }, `gap:${payload.id}`);
  }

  async resolveGap(missionId: string, gapId: string) {
    await this.emit(missionId, "gap.resolved", { id: gapId }, { type: "verifier" }, `gap-resolved:${gapId}`);
  }

  async validateArtifact(missionId: string, artifactRef: string, final = false) {
    await this.emit(missionId, "artifact.validated", { artifactRef, final }, { type: "verifier" }, `artifact-validated:${artifactRef}:${final}`);
  }

  async completeIfEligible(missionId: string): Promise<MissionState> {
    const state = await this.state(missionId);
    if (state.status === "completed") return state;
    if (state.blockingGapIds.length > 0) return state;
    if (state.readyWorkItemIds.length > 0 || state.activeWorkItemIds.length > 0 || state.activeExecutionIds.length > 0) return state;
    if (state.finalArtifactRefs.length === 0) return state;
    await this.emit(missionId, "mission.completed", { reason: "deterministic completion gate passed" }, { type: "controller" }, `mission-completed:${state.revision}`);
    return this.state(missionId);
  }

  async runControllerCycle(input: ControllerCycleInput): Promise<ControllerCycleResult> {
    // v0.1 cycle is intentionally event-driven and side-effect light. Planning/execution providers subscribe around this boundary.
    const before = await this.state(input.missionId);
    const after = await this.completeIfEligible(input.missionId);
    return {
      missionRevision: after.revision,
      decisionsCreated: [],
      workItemsCreated: [],
      executionsDispatched: [],
      verificationsScheduled: [],
      status: after.status === before.status ? before.status : after.status
    };
  }

  async state(missionId: string) {
    return projectMissionState(missionId, await this.store.list(missionId));
  }
}
