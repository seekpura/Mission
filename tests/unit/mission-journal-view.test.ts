import test from "node:test";
import assert from "node:assert/strict";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import { projectMissionJournal, openGaps } from "../../src/core/mission/journal-view.ts";
import { projectMissionState } from "../../src/core/events/state-projector.ts";

function event(sequence: number, type: MissionEvent["type"], payload: unknown): MissionEvent {
  return {
    id: `event-${sequence}`,
    missionId: "mission-view",
    sequence,
    type,
    actor: { type: "controller" },
    payload,
    schemaVersion: 1,
    createdAt: new Date(1_000 + sequence).toISOString()
  };
}

function work(): WorkItem {
  const at = new Date(2_000).toISOString();
  return {
    id: "work-1",
    missionId: "mission-view",
    purpose: "repair",
    objective: "repair gap",
    status: "ready",
    requirementRefs: ["req-1"],
    gapRefs: ["gap-1"],
    inputArtifactRefs: [],
    expectedOutputs: [],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [],
    priority: 1,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: at,
    updatedAt: at
  };
}

test("journal reconstructs mission goal, work entities, gap entities and decisions", () => {
  const events: MissionEvent[] = [
    event(1, "mission.created", { userGoal: "ship a verified artifact" }),
    event(2, "work.created", { id: "work-1", status: "ready", work: work() }),
    event(3, "work.started", { id: "work-1" }),
    event(4, "work.failed", { id: "work-1" }),
    event(5, "gap.opened", { id: "gap-1", severity: "major", description: "failed verification" }),
    event(6, "decision.created", { id: "decision-1" })
  ];

  const view = projectMissionJournal("mission-view", events);
  assert.equal(view.userGoal, "ship a verified artifact");
  assert.equal(view.workItems.get("work-1")?.status, "failed");
  assert.equal(view.gaps.get("gap-1")?.category, "quality");
  assert.equal(openGaps(view).length, 1);
  assert.equal(view.decisionIds.has("decision-1"), true);
});

test("work status projection removes stale memberships when status changes", () => {
  const events: MissionEvent[] = [
    event(1, "mission.created", { userGoal: "test" }),
    event(2, "work.created", { id: "work-1", status: "ready" }),
    event(3, "work.updated", { id: "work-1", status: "blocked" }),
    event(4, "work.updated", { id: "work-1", status: "ready" }),
    event(5, "work.started", { id: "work-1" }),
    event(6, "work.updated", { id: "work-1", status: "verifying" })
  ];

  const state = projectMissionState("mission-view", events);
  assert.deepEqual(state.readyWorkItemIds, []);
  assert.deepEqual(state.blockedWorkItemIds, []);
  assert.deepEqual(state.activeWorkItemIds, []);
  assert.deepEqual(state.verifyingWorkItemIds, ["work-1"]);
});
