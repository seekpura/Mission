import type { Artifact, ArtifactStatus } from "../domain/artifact.ts";
import type { CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import type { MissionEvent } from "../domain/event.ts";
import type { MissionSteeringMessage } from "../domain/mission.ts";
import type { WorkItem, WorkStatus } from "../domain/work-item.ts";
import type { Gap } from "../domain/verification.ts";

export interface MissionJournalView {
  missionId: string;
  userGoal: string;
  steeringMessages: MissionSteeringMessage[];
  workItems: Map<string, WorkItem>;
  artifacts: Map<string, Artifact>;
  capabilityNeeds: Map<string, CapabilityNeed>;
  capabilities: Map<string, CapabilityDescriptor>;
  gaps: Map<string, Gap>;
  decisionIds: Set<string>;
}

export function projectMissionJournal(missionId: string, events: MissionEvent[]): MissionJournalView {
  const steeringMessages: MissionSteeringMessage[] = [];
  const workItems = new Map<string, WorkItem>();
  const artifacts = new Map<string, Artifact>();
  const capabilityNeeds = new Map<string, CapabilityNeed>();
  const capabilities = new Map<string, CapabilityDescriptor>();
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
      case "user.steering.received": {
        const payload = event.payload as { message?: string };
        if (typeof payload.message === "string" && payload.message.trim()) {
          steeringMessages.push({
            sequence: event.sequence,
            message: payload.message.trim(),
            receivedAt: event.createdAt
          });
        }
        break;
      }
      case "capability.need.created": {
        const payload = event.payload as { need?: CapabilityNeed } & Partial<CapabilityNeed>;
        const need = payload.need ?? asCapabilityNeed(payload, missionId);
        if (need) capabilityNeeds.set(need.id, cloneCapabilityNeed(need));
        break;
      }
      case "capability.activated": {
        const payload = event.payload as { capability?: CapabilityDescriptor } & Partial<CapabilityDescriptor>;
        const capability = payload.capability ?? asCapabilityDescriptor(payload);
        if (capability) capabilities.set(capability.id, cloneCapability(capability));
        break;
      }
      case "capability.deactivated":
      case "capability.revoked":
      case "capability.rejected": {
        const payload = event.payload as { capabilityId?: string };
        if (payload.capabilityId) capabilities.delete(payload.capabilityId);
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
        workItems.set(payload.id, cloneWork({
          ...current,
          ...(payload.work ?? {}),
          ...(payload.status ? { status: payload.status } : {}),
          updatedAt: event.createdAt
        }));
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

  return {
    missionId,
    userGoal,
    steeringMessages,
    workItems,
    artifacts,
    capabilityNeeds,
    capabilities,
    gaps,
    decisionIds
  };
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
  items.set(id, cloneWork({ ...current, status, updatedAt: at }));
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
    ...(payload.policy ? { policy: cloneNeedPolicy(payload.policy) } : {}),
    requirementRefs: [...(payload.requirementRefs ?? [])],
    gapRefs: [...(payload.gapRefs ?? [])]
  };
}

function asCapabilityDescriptor(payload: Partial<CapabilityDescriptor>): CapabilityDescriptor | undefined {
  if (!payload.id || !payload.kind || !payload.name || !payload.description || !payload.scope) return undefined;
  return cloneCapability({
    id: payload.id,
    kind: payload.kind,
    name: payload.name,
    description: payload.description,
    hostNative: payload.hostNative ?? false,
    available: payload.available ?? true,
    ...(payload.invocationRef ? { invocationRef: payload.invocationRef } : {}),
    permissions: [...(payload.permissions ?? [])],
    ...(payload.revision ? { revision: payload.revision } : {}),
    scope: payload.scope,
    ...(payload.functions ? { functions: [...payload.functions] } : {}),
    ...(payload.accepts ? { accepts: [...payload.accepts] } : {}),
    ...(payload.produces ? { produces: [...payload.produces] } : {}),
    ...(payload.constraints ? { constraints: structuredClone(payload.constraints) } : {}),
    ...(payload.routing ? { routing: structuredClone(payload.routing) } : {}),
    ...(payload.cost ? { cost: { ...payload.cost } } : {}),
    ...(payload.native ? { native: structuredClone(payload.native) } : {}),
    ...(payload.provenance ? { provenance: { ...payload.provenance } } : {})
  });
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
    ...(payload.supersedesWorkItemRefs ? { supersedesWorkItemRefs: [...payload.supersedesWorkItemRefs] } : {}),
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
    ...(need.policy ? { policy: cloneNeedPolicy(need.policy) } : {}),
    requirementRefs: [...need.requirementRefs],
    gapRefs: [...need.gapRefs]
  };
}

function cloneNeedPolicy(policy: NonNullable<CapabilityNeed["policy"]>): NonNullable<CapabilityNeed["policy"]> {
  return {
    ...(policy.acceptableKinds ? { acceptableKinds: [...policy.acceptableKinds] } : {}),
    ...(policy.requiredExecutionModes ? { requiredExecutionModes: [...policy.requiredExecutionModes] } : {}),
    ...(policy.forbiddenPermissions ? { forbiddenPermissions: [...policy.forbiddenPermissions] } : {}),
    ...(policy.acceptableProviders ? { acceptableProviders: [...policy.acceptableProviders] } : {}),
    ...(policy.requiredNativeFeatures ? { requiredNativeFeatures: [...policy.requiredNativeFeatures] } : {}),
    ...(policy.acceptableProvenanceSources ? { acceptableProvenanceSources: [...policy.acceptableProvenanceSources] } : {}),
    ...(policy.maxMonetaryClass ? { maxMonetaryClass: policy.maxMonetaryClass } : {})
  };
}

function cloneCapability(capability: CapabilityDescriptor): CapabilityDescriptor {
  return {
    ...capability,
    permissions: [...capability.permissions],
    ...(capability.functions ? { functions: [...capability.functions] } : {}),
    ...(capability.accepts ? { accepts: [...capability.accepts] } : {}),
    ...(capability.produces ? { produces: [...capability.produces] } : {}),
    ...(capability.constraints ? { constraints: structuredClone(capability.constraints) } : {}),
    ...(capability.routing ? { routing: structuredClone(capability.routing) } : {}),
    ...(capability.cost ? { cost: { ...capability.cost } } : {}),
    ...(capability.native ? { native: structuredClone(capability.native) } : {}),
    ...(capability.provenance ? { provenance: { ...capability.provenance } } : {})
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
    capabilityNeedRefs: [...work.capabilityNeedRefs],
    ...(work.supersedesWorkItemRefs ? { supersedesWorkItemRefs: [...work.supersedesWorkItemRefs] } : {})
  };
}

function cloneArtifact(artifact: Artifact): Artifact {
  return { ...artifact, sourceArtifactRefs: [...artifact.sourceArtifactRefs] };
}
