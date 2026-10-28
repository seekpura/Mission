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

export function projectMissionState(missionId: string, events: MissionEvent[]): MissionState {
  const s = initialMissionState(missionId);
  for (const event of events) {
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
        projectWorkStatus(s, p.id, p.status ?? "ready");
        if (p.workstreamId) addUnique(s.activeWorkstreamIds, p.workstreamId);
        break;
      }
      case "work.started": {
        const id = (event.payload as { id: string }).id;
        projectWorkStatus(s, id, "running");
        break;
      }
      case "work.updated": {
        const p = event.payload as { id: string; status: string };
        projectWorkStatus(s, p.id, p.status);
        break;
      }
      case "work.completed":
      case "work.failed":
      case "work.invalidated": {
        const id = (event.payload as { id: string }).id;
        removeWorkFromStatusLists(s, id);
        break;
      }
      case "work.blocked": {
        const id = (event.payload as { id: string }).id;
        projectWorkStatus(s, id, "blocked");
        break;
      }
      case "execution.started": {
        addUnique(s.activeExecutionIds, (event.payload as { id: string }).id);
        break;
      }
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
      case "artifact.invalidated":
      case "artifact.superseded": {
        const ref = (event.payload as { artifactRef?: string }).artifactRef;
        if (ref) s.finalArtifactRefs = remove(s.finalArtifactRefs, ref);
        break;
      }
      case "mission.completed":
        s.status = "completed";
        break;
      case "mission.reopened":
        s.status = "reopened";
        break;
    }
  }
  return s;
}
