import type { MissionEvent } from "../domain/event.ts";
import type { MissionState } from "../domain/mission.ts";

export function initialMissionState(missionId: string): MissionState {
  return {
    missionId,
    status: "created",
    revision: 0,
    missionSpecRevision: 0,
    acceptanceRevision: 0,
    strategyRevision: null,
    graphRevision: 0,
    environmentSnapshotRevision: 0,
    activeWorkstreamIds: [],
    activeWorkItemIds: [],
    readyWorkItemIds: [],
    blockedWorkItemIds: [],
    verifyingWorkItemIds: [],
    openGapIds: [],
    blockingGapIds: [],
    activeExecutionIds: [],
    pendingApprovalIds: [],
    finalArtifactRefs: [],
    lastEventSequence: 0
  };
}

function addUnique(list: string[], id: string) {
  if (!list.includes(id)) list.push(id);
}

function remove(list: string[], id: string) {
  return list.filter(x => x !== id);
}

function removeWorkFromStatusLists(state: MissionState, id: string): void {
  state.activeWorkItemIds = remove(state.activeWorkItemIds, id);
  state.readyWorkItemIds = remove(state.readyWorkItemIds, id);
  state.blockedWorkItemIds = remove(state.blockedWorkItemIds, id);
  state.verifyingWorkItemIds = remove(state.verifyingWorkItemIds, id);
}

function projectWorkStatus(state: MissionState, id: string, status: string): void {
  removeWorkFromStatusLists(state, id);
  if (status === "ready") addUnique(state.readyWorkItemIds, id);
  if (status === "running") addUnique(state.activeWorkItemIds, id);
  if (status === "verifying") addUnique(state.verifyingWorkItemIds, id);
  if (status === "blocked" || status === "waiting") addUnique(state.blockedWorkItemIds, id);
}

export function applyMissionEvent(state: MissionState, event: MissionEvent): MissionState {
  if (event.missionId !== state.missionId) {
    throw new Error(`MissionState/event mission mismatch: ${state.missionId} != ${event.missionId}`);
  }
  if (event.sequence <= state.lastEventSequence) {
    throw new Error(`MissionState event sequence must advance: current=${state.lastEventSequence}, received=${event.sequence}`);
  }

  state.lastEventSequence = event.sequence;
  state.revision += 1;
  state.updatedAt = event.createdAt;
  switch (event.type) {
    case "mission.created":
      state.status = "active";
      state.createdAt = event.createdAt;
      break;
    case "mission.status.changed":
      state.status = (event.payload as { status: MissionState["status"] }).status;
      break;
    case "mission.spec.revised":
      state.missionSpecRevision = (event.payload as { revision: number }).revision;
      break;
    case "acceptance.created":
    case "acceptance.revised":
      state.acceptanceRevision = (event.payload as { revision: number }).revision;
      break;
    case "strategy.created":
    case "strategy.revised":
      state.strategyRevision = (event.payload as { revision: number }).revision;
      break;
    case "graph.revised":
      state.graphRevision = (event.payload as { revision: number }).revision;
      break;
    case "environment.snapshot.created":
      state.environmentSnapshotRevision = (event.payload as { revision: number }).revision;
      break;
    case "work.created": {
      const p = event.payload as { id: string; status?: string; workstreamId?: string };
      projectWorkStatus(state, p.id, p.status ?? "ready");
      if (p.workstreamId) addUnique(state.activeWorkstreamIds, p.workstreamId);
      break;
    }
    case "work.started": {
      const id = (event.payload as { id: string }).id;
      projectWorkStatus(state, id, "running");
      break;
    }
    case "work.updated": {
      const p = event.payload as { id: string; status: string };
      projectWorkStatus(state, p.id, p.status);
      break;
    }
    case "work.completed":
    case "work.failed":
    case "work.invalidated":
    case "work.superseded": {
      const id = (event.payload as { id: string }).id;
      removeWorkFromStatusLists(state, id);
      break;
    }
    case "work.blocked": {
      const id = (event.payload as { id: string }).id;
      projectWorkStatus(state, id, "blocked");
      break;
    }
    case "execution.started":
      addUnique(state.activeExecutionIds, (event.payload as { id: string }).id);
      break;
    case "execution.completed":
    case "execution.failed":
    case "execution.lost":
    case "execution.cancelled": {
      const id = (event.payload as { id: string }).id;
      state.activeExecutionIds = remove(state.activeExecutionIds, id);
      break;
    }
    case "gap.opened": {
      const p = event.payload as { id: string; severity: string; blocking?: boolean };
      addUnique(state.openGapIds, p.id);
      if (p.blocking ?? (p.severity === "critical" || p.severity === "major")) addUnique(state.blockingGapIds, p.id);
      break;
    }
    case "gap.resolved":
    case "gap.accepted": {
      const id = (event.payload as { id: string }).id;
      state.openGapIds = remove(state.openGapIds, id);
      state.blockingGapIds = remove(state.blockingGapIds, id);
      break;
    }
    case "approval.requested":
      addUnique(state.pendingApprovalIds, (event.payload as { id: string }).id);
      break;
    case "approval.decided":
      state.pendingApprovalIds = remove(state.pendingApprovalIds, (event.payload as { id: string }).id);
      break;
    case "artifact.validated": {
      const p = event.payload as { artifactRef: string; final?: boolean };
      if (p.final) addUnique(state.finalArtifactRefs, p.artifactRef);
      break;
    }
    case "artifact.invalidated":
    case "artifact.superseded": {
      const ref = (event.payload as { artifactRef?: string }).artifactRef;
      if (ref) state.finalArtifactRefs = remove(state.finalArtifactRefs, ref);
      break;
    }
    case "mission.completed":
      state.status = "completed";
      break;
    case "mission.reopened":
      state.status = "reopened";
      break;
  }
  return state;
}

export function projectMissionState(missionId: string, events: MissionEvent[]): MissionState {
  const state = initialMissionState(missionId);
  for (const event of events) applyMissionEvent(state, event);
  return state;
}
