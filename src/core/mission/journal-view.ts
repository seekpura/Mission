import type { Artifact, ArtifactStatus } from "../domain/artifact.ts";
import type { CapabilityNeed } from "../domain/capability.ts";
import type { MissionEvent } from "../domain/event.ts";
import type { WorkItem, WorkStatus } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";

export interface MissionJournalView {
  missionId: string;
  userGoal: string;
  workItems: Map<string, WorkItem>;
  artifacts: Map<string, Artifact>;
  capabilityNeeds: Map<string, CapabilityNeed>;
  gaps: Map<string, Gap>;
  decisionIds: Set<string>;
}

export function projectMissionJournal(missionId: string, events: MissionEvent[]): MissionJournalView {
  const workItems = new Map<string, WorkItem>();
  const artifacts = new Map<string, Artifact>();
  const capabilityNeeds = new Map<string, CapabilityNeed>();
  const gaps = new Map<string, Gap>();
  const decisionIds = new Set<string>();
  let userGoal = "";

  for (const event of events) {
    switch (event.type) {
      case "mission.created": {
        const payload = event.payload as { userGoal?: string };
        if (typeof payload.userGoal === "string") userGoal = payload.userGoal;
        break;
      }
      case "capability.need.created": {
        const payload = event.payload as { need?: CapabilityNeed } & Partial<CapabilityNeed>;
        const need = payload.need ?? asCapabilityNeed(payload, missionId);
        if (need) capabilityNeeds.set(need.id, cloneCapabilityNeed(need));
        break;
      }
      case "work.created": {
        const payload = event.payload as { work?: WorkItem } & Partial<WorkItem>;
        const work = payload.work ?? asWorkItem(payload, missionId, event.createdAt);
        if (work) workItems.set(work.id, cloneWork(work));
        break;
      }
      case "work.updated": {
        const payload = event.payload as { id: string; status?: WorkStatus; work?: Partial<WorkItem> };
        const current = workItems.get(payload.id);
        if (!current) break;
        workItems.set(payload.id, {
          ...current,
          ...(payload.work ?? {}),
          ...(payload.status ? { status: payload.status } : {}),
          updatedAt: event.createdAt
        });
        break;
      }
      case "work.started":
        updateWorkStatus(workItems, event.payload, "running", event.createdAt);
        break;
      case "work.completed":
        updateWorkStatus(workItems, event.payload, "succeeded", event.createdAt);
        break;
      case "work.failed":
        updateWorkStatus(workItems, event.payload, "failed", event.createdAt);
        break;
      case "work.blocked":
        updateWorkStatus(workItems, event.payload, "blocked", event.createdAt);
        break;
      case "work.invalidated":
        updateWorkStatus(workItems, event.payload, "invalidated", event.createdAt);
        break;
      case "artifact.created": {
        const payload = event.payload as { artifact?: Artifact } & Partial<Artifact>;
        const artifact = payload.artifact ?? asArtifact(payload, missionId, event.createdAt);
        if (artifact) artifacts.set(artifactRef(artifact), cloneArtifact(artifact));
        break;
      }
      case "artifact.validated": {
        const payload = event.payload as { artifactRef?: string; final?: boolean };
        if (payload.artifactRef) updateArtifactStatus(artifacts, payload.artifactRef, payload.final ? "final" : "verified");
        break;
      }
      case "artifact.invalidated": {
        const payload = event.payload as { artifactRef?: string };
        if (payload.artifactRef) updateArtifactStatus(artifacts, payload.artifactRef, "invalid");
        break;
      }
      case "artifact.superseded": {
        const payload = event.payload as { artifactRef?: string };
        if (payload.artifactRef) updateArtifactStatus(artifacts, payload.artifactRef, "superseded");
        break;
      }
      case "gap.opened": {
        const payload = event.payload as Partial<Gap> & {
          id: string;
          severity: Gap["severity"];
          description: string;
        };
        gaps.set(payload.id, {
          id: payload.id,
          missionId: payload.missionId ?? missionId,
          category: payload.category ?? "quality",
          severity: payload.severity,
          description: payload.description,
          findingRefs: [...(payload.findingRefs ?? [])],
          requirementRefs: [...(payload.requirementRefs ?? [])],
          artifactRefs: [...(payload.artifactRefs ?? [])],
          status: payload.status ?? "open",
          openedAt: payload.openedAt ?? event.createdAt,
          ...(payload.resolvedAt ? { resolvedAt: payload.resolvedAt } : {})
        });
        break;
      }
      case "gap.resolved":
        updateGapStatus(gaps, event.payload, "resolved", event.createdAt);
        break;
      case "gap.accepted":
        updateGapStatus(gaps, event.payload, "accepted", event.createdAt);
        break;
      case "decision.created": {
        const payload = event.payload as { id?: string };
        if (payload.id) decisionIds.add(payload.id);
        break;
      }
    }
  }

  return { missionId, userGoal, workItems, artifacts, capabilityNeeds, gaps, decisionIds };
}

export function openGaps(view: MissionJournalView): Gap[] {
  return [...view.gaps.values()].filter(gap => gap.status === "open" || gap.status === "working" || gap.status === "blocked");
}

export function hasNonTerminalWorkForGap(view: MissionJournalView, gapId: string): boolean {
  return [...view.workItems.values()].some(work =>
    work.gapRefs.includes(gapId) && !isTerminalWorkStatus(work.status)
  );
}

export function terminalWorkCountForGap(view: MissionJournalView, gapId: string): number {
  return [...view.workItems.values()].filter(work =>
    work.gapRefs.includes(gapId) && isTerminalWorkStatus(work.status)
  ).length;
}

export function isTerminalWorkStatus(status: WorkStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "invalidated" ||
    status === "superseded" || status === "abandoned";
}

function updateWorkStatus(
  items: Map<string, WorkItem>,
  payload: unknown,
  status: WorkStatus,
  at: string
): void {
  const id = (payload as { id?: string }).id;
  if (!id) return;
  const current = items.get(id);
  if (!current) return;
  items.set(id, { ...current, status, updatedAt: at });
}

function updateGapStatus(
  gaps: Map<string, Gap>,
  payload: unknown,
  status: "resolved" | "accepted",
  at: string
): void {
  const id = (payload as { id?: string }).id;
  if (!id) return;
  const current = gaps.get(id);
  if (!current) return;
  gaps.set(id, { ...current, status, resolvedAt: at });
}

function updateArtifactStatus(artifacts: Map<string, Artifact>, ref: string, status: ArtifactStatus): void {
  const current = artifacts.get(ref);
  if (!current) return;
  artifacts.set(ref, { ...current, status });
}

function asCapabilityNeed(payload: Partial<CapabilityNeed>, missionId: string): CapabilityNeed | undefined {
  if (!payload.id || !payload.objective || !payload.purpose || !payload.urgency || !payload.maxRisk) return undefined;
  return {
    id: payload.id,
    missionId: payload.missionId ?? missionId,
    objective: payload.objective,
    requiredFunctions: [...(payload.requiredFunctions ?? [])],
    desiredInputs: [...(payload.desiredInputs ?? [])],
    desiredOutputs: [...(payload.desiredOutputs ?? [])],
    purpose: payload.purpose,
    urgency: payload.urgency,
    acquisitionAllowed: payload.acquisitionAllowed ?? false,
    maxRisk: payload.maxRisk,
    requirementRefs: [...(payload.requirementRefs ?? [])],
    gapRefs: [...(payload.gapRefs ?? [])]
  };
}

function asWorkItem(payload: Partial<WorkItem>, missionId: string, at: string): WorkItem | undefined {
  if (!payload.id || !payload.objective || !payload.purpose) return undefined;
  return {
    id: payload.id,
    missionId: payload.missionId ?? missionId,
    ...(payload.workstreamId ? { workstreamId: payload.workstreamId } : {}),
    ...(payload.parentWorkItemId ? { parentWorkItemId: payload.parentWorkItemId } : {}),
    purpose: payload.purpose,
    objective: payload.objective,
    status: payload.status ?? "ready",
    requirementRefs: [...(payload.requirementRefs ?? [])],
    gapRefs: [...(payload.gapRefs ?? [])],
    inputArtifactRefs: [...(payload.inputArtifactRefs ?? [])],
    expectedOutputs: [...(payload.expectedOutputs ?? [])],
    localAcceptanceCriteria: [...(payload.localAcceptanceCriteria ?? [])],
    capabilityNeedRefs: [...(payload.capabilityNeedRefs ?? [])],
    ...(payload.assignedExecutorId ? { assignedExecutorId: payload.assignedExecutorId } : {}),
    priority: payload.priority ?? 0,
    graphRevision: payload.graphRevision ?? 0,
    createdBy: payload.createdBy ?? "system",
    createdAt: payload.createdAt ?? at,
    updatedAt: payload.updatedAt ?? at
  };
}

function asArtifact(payload: Partial<Artifact>, missionId: string, at: string): Artifact | undefined {
  if (!payload.id || !payload.logicalName || !payload.type || payload.version === undefined || !payload.uri || !payload.contentHash || !payload.producedByAttemptId) return undefined;
  return {
    id: payload.id,
    missionId: payload.missionId ?? missionId,
    logicalName: payload.logicalName,
    type: payload.type,
    version: payload.version,
    status: payload.status ?? "candidate",
    uri: payload.uri,
    contentHash: payload.contentHash,
    ...(payload.mimeType ? { mimeType: payload.mimeType } : {}),
    ...(payload.sizeBytes === undefined ? {} : { sizeBytes: payload.sizeBytes }),
    producedByAttemptId: payload.producedByAttemptId,
    sourceArtifactRefs: [...(payload.sourceArtifactRefs ?? [])],
    createdAt: payload.createdAt ?? at
  };
}

function artifactRef(artifact: Artifact): string {
  return `${artifact.id}@${artifact.version}`;
}

function cloneCapabilityNeed(need: CapabilityNeed): CapabilityNeed {
  return {
    ...need,
    requiredFunctions: [...need.requiredFunctions],
    desiredInputs: [...need.desiredInputs],
    desiredOutputs: [...need.desiredOutputs],
    requirementRefs: [...need.requirementRefs],
    gapRefs: [...need.gapRefs]
  };
}

function cloneWork(work: WorkItem): WorkItem {
  return {
    ...work,
    requirementRefs: [...work.requirementRefs],
    gapRefs: [...work.gapRefs],
    inputArtifactRefs: [...work.inputArtifactRefs],
    expectedOutputs: work.expectedOutputs.map(output => ({ ...output })),
    localAcceptanceCriteria: work.localAcceptanceCriteria.map(criterion => ({ ...criterion })),
    capabilityNeedRefs: [...work.capabilityNeedRefs]
  };
}

function cloneArtifact(artifact: Artifact): Artifact {
  return { ...artifact, sourceArtifactRefs: [...artifact.sourceArtifactRefs] };
}
