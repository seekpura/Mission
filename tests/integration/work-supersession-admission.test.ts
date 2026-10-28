import assert from "node:assert/strict";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import type { DeliberationProvider } from "../../src/core/planning/deliberation-provider.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

class MemoryEventStore implements EventStore {
  readonly events: MissionEvent[] = [];

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const scoped = this.events.filter(item => item.missionId === event.missionId);
    if (event.idempotencyKey) {
      const existing = scoped.find(item => item.idempotencyKey === event.idempotencyKey);
      if (existing) return existing as MissionEvent<T>;
    }
    if (scoped.length !== expectedSequence) {
      const error = new Error(`Concurrency conflict: expected ${expectedSequence}, current ${scoped.length}`);
      error.name = "ConcurrencyConflictError";
      throw error;
    }
    const committed = { ...event, sequence: scoped.length + 1 } as MissionEvent<T>;
    this.events.push(committed as MissionEvent);
    return committed;
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    return this.events.filter(event => event.missionId === missionId && event.sequence > afterSequence);
  }

  async lastSequence(missionId: string): Promise<number> {
    return this.events.filter(event => event.missionId === missionId).length;
  }
}

function work(missionId: string, id: string, supersedesWorkItemRefs: string[] = []): WorkItem {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: supersedesWorkItemRefs.length > 0 ? "repair" : "production",
    objective: id,
    status: "proposed",
    requirementRefs: ["req-1"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "acceptance", description: "deliverable exists", priority: "required" }],
    capabilityNeedRefs: [],
    ...(supersedesWorkItemRefs.length > 0 ? { supersedesWorkItemRefs: [...supersedesWorkItemRefs] } : {}),
    priority: 1,
    graphRevision: 0,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

function plannerFor(candidate: WorkItem): DeliberationProvider {
  return {
    async composeStrategy() {
      return {
        framing: "supersession admission fixture",
        approach: "validate explicit replacement relation",
        workstreams: [{ id: "stream", objective: "deliver" }],
        revision: 1
      };
    },
    async planFrontier() {
      return { graphRevision: 1, capabilityNeeds: [], workItems: [candidate] };
    },
    async diagnoseGap(input) {
      return { gapId: input.gap.id, rootCause: "fixture", intervention: "revise_work", confidence: 1 };
    },
    async challengeCompletion() {
      return { blockingObjection: false, objections: [], confidence: 1 };
    }
  };
}

test("frontier admission rejects a replacement that references an unknown WorkItem", async () => {
  const missionId = "mission-supersession-unknown";
  const store = new MemoryEventStore();
  const controller = new MissionController(store, plannerFor(work(missionId, "replacement", ["missing-work"])));
  await controller.createMission(missionId, "reject unknown replacement target");
  await assert.rejects(
    () => controller.runControllerCycle({ missionId, trigger: "mission_created" }),
    /unknown superseded WorkItem missing-work/
  );
});

test("frontier admission rejects self-supersession", async () => {
  const missionId = "mission-supersession-self";
  const store = new MemoryEventStore();
  const controller = new MissionController(store, plannerFor(work(missionId, "replacement", ["replacement"])));
  await controller.createMission(missionId, "reject self replacement");
  await assert.rejects(
    () => controller.runControllerCycle({ missionId, trigger: "mission_created" }),
    /cannot supersede itself/
  );
});

test("frontier admission rejects replacing a WorkItem that already succeeded", async () => {
  const missionId = "mission-supersession-succeeded";
  const store = new MemoryEventStore();
  const replacement = work(missionId, "replacement", ["successful-work"]);
  const controller = new MissionController(store, plannerFor(replacement));
  await controller.createMission(missionId, "do not erase successful Work history");
  const successful = work(missionId, "successful-work");
  successful.status = "ready";
  await controller.proposeWork(successful);
  await controller.emit(
    missionId,
    "work.completed",
    { id: successful.id, attemptId: "attempt-success", artifactRefs: ["deliverable@1"] },
    { type: "controller" },
    "successful-work-completed"
  );

  await assert.rejects(
    () => controller.runControllerCycle({ missionId, trigger: "manual" }),
    /cannot supersede WorkItem successful-work in status succeeded/
  );
});
