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

function cloneState(state: MissionState): MissionState {
  return {
    ...state,
    activeWorkstreamIds: [...state.activeWorkstreamIds],
    activeWorkItemIds: [...state.activeWorkItemIds],
    readyWorkItemIds: [...state.readyWorkItemIds],
    blockedWorkItemIds: [...state.blockedWorkItemIds],
    verifyingWorkItemIds: [...state.verifyingWorkItemIds],
    openGapIds: [...state.openGapIds],
    blockingGapIds: [...state.blockingGapIds],
    activeExecutionIds: [...state.activeExecutionIds],
    pendingApprovalIds: [...state.pendingApprovalIds],
    finalArtifactRefs: [...state.finalArtifactRefs]
  };
}

export function applyMissionEvent(state: MissionState, event: MissionEvent): MissionState {
  const s = cloneState(state);
  if (event.sequence <= s.lastEventSequence) return s;
  s.lastEventSequence = event.sequence;
  s.revision += 1;
  s.updatedAt = event.createdAt;

  switch (event.type) {
    case "mission.created":
      s.status = "active";
      s.createdAt = event.createdAt;
      break;
    case "mission.status.changed":
      s.status = (event.payload as { status: MissionState["status"] }).status;
      break;
    case "mission.spec.revised":
      s.missionSpecRevision = (event.payload as { revision: number }).revision;
      break;
    case "acceptance.created":
    case "acceptance.revised":
      s.acceptanceRevision = (event.payload as { revision: number }).revision;
      break;
    case "strategy.created":
    case "strategy.revised":
      s.strategyRevision = (event.payload as { revision: number }).revision;
      break;
    case "graph.revised":
      s.graphRevision = (event.payload as { revision: number }).revision;
      break;
    case "environment.snapshot.created":
      s.environmentSnapshotRevision = (event.payload as { revision: number }).revision;
      break;
    case "work.created": {
      const p = event.payload as { id: string; status?: string; workstreamId?: string };
      const status = p.status ?? "ready";
      if (status === "ready") addUnique(s.readyWorkItemIds, p.id);
      if (status === "running") addUnique(s.activeWorkItemIds, p.id);
      if (status === "verifying") addUnique(s.verifyingWorkItemIds, p.id);
      if (status === "blocked") addUnique(s.blockedWorkItemIds, p.id);
      if (p.workstreamId) addUnique(s.activeWorkstreamIds, p.workstreamId);
      break;
    }
    case "work.started": {
      const id = (event.payload as { id: string }).id;
      s.readyWorkItemIds = remove(s.readyWorkItemIds, id);
      s.blockedWorkItemIds = remove(s.blockedWorkItemIds, id);
      addUnique(s.activeWorkItemIds, id);
      break;
    }
    case "work.updated": {
      const p = event.payload as { id: string; status: string };
      s.readyWorkItemIds = remove(s.readyWorkItemIds, p.id);
      s.activeWorkItemIds = remove(s.activeWorkItemIds, p.id);
      s.verifyingWorkItemIds = remove(s.verifyingWorkItemIds, p.id);
      s.blockedWorkItemIds = remove(s.blockedWorkItemIds, p.id);
      if (p.status === "ready") addUnique(s.readyWorkItemIds, p.id);
      if (p.status === "running") addUnique(s.activeWorkItemIds, p.id);
      if (p.status === "verifying") addUnique(s.verifyingWorkItemIds, p.id);
      if (p.status === "blocked") addUnique(s.blockedWorkItemIds, p.id);
      break;
    }
    case "work.completed":
    case "work.failed":
    case "work.invalidated": {
      const id = (event.payload as { id: string }).id;
      s.activeWorkItemIds = remove(s.activeWorkItemIds, id);
      s.readyWorkItemIds = remove(s.readyWorkItemIds, id);
      s.verifyingWorkItemIds = remove(s.verifyingWorkItemIds, id);
      s.blockedWorkItemIds = remove(s.blockedWorkItemIds, id);
      break;
    }
    case "work.blocked": {
      const id = (event.payload as { id: string }).id;
      s.activeWorkItemIds = remove(s.activeWorkItemIds, id);
      s.readyWorkItemIds = remove(s.readyWorkItemIds, id);
      addUnique(s.blockedWorkItemIds, id);
      break;
    }
    case "execution.started":
      addUnique(s.activeExecutionIds, (event.payload as { id: string }).id);
      break;
    case "execution.completed":
    case "execution.failed":
    case "execution.lost":
    case "execution.cancelled": {
      const id = (event.payload as { id: string }).id;
      s.activeExecutionIds = remove(s.activeExecutionIds, id);
      break;
    }
    case "gap.opened": {
      const p = event.payload as { id: string; severity: string; blocking?: boolean };
      addUnique(s.openGapIds, p.id);
      if (p.blocking ?? (p.severity === "critical" || p.severity === "major")) addUnique(s.blockingGapIds, p.id);
      break;
    }
    case "gap.resolved":
    case "gap.accepted": {
      const id = (event.payload as { id: string }).id;
      s.openGapIds = remove(s.openGapIds, id);
      s.blockingGapIds = remove(s.blockingGapIds, id);
      break;
    }
    case "approval.requested":
      addUnique(s.pendingApprovalIds, (event.payload as { id: string }).id);
      break;
    case "approval.decided":
      s.pendingApprovalIds = remove(s.pendingApprovalIds, (event.payload as { id: string }).id);
      break;
    case "artifact.validated": {
      const p = event.payload as { artifactRef: string; final?: boolean };
      if (p.final) addUnique(s.finalArtifactRefs, p.artifactRef);
      break;
    }
    case "artifact.invalidated": {
      const p = event.payload as { artifactRef: string };
      s.finalArtifactRefs = remove(s.finalArtifactRefs, p.artifactRef);
      break;
    }
    case "mission.completed":
      s.status = "completed";
      break;
    case "mission.reopened":
      s.status = "reopened";
      break;
  }
  return s;
}

export function projectMissionState(missionId: string, events: MissionEvent[]): MissionState {
  let state = initialMissionState(missionId);
  for (const event of events) state = applyMissionEvent(state, event);
  return state;
}
