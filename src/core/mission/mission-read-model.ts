import type { Artifact } from "../domain/artifact.ts";
import type { AcceptanceContract, Requirement } from "../domain/mission.ts";
import type { Evidence, Finding, Gap, VerificationResult } from "../domain/verification.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { EventStore } from "../events/event-store.ts";
import type { MissionProjectionReader } from "../events/projection-store.ts";

export class MissionReadModel {
  private readonly store: EventStore;
  private readonly projections?: MissionProjectionReader;

  constructor(store: EventStore, projections?: MissionProjectionReader) {
    this.store = store;
    this.projections = projections;
  }

  async userGoal(missionId: string): Promise<string> {
    const events = await this.store.list(missionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type !== "mission.spec.revised") continue;
      const objective = (event.payload as { objective?: string }).objective;
      if (objective) return objective;
    }
    const created = events.find(event => event.type === "mission.created");
    return (created?.payload as { userGoal?: string } | undefined)?.userGoal ?? "";
  }

  async workItems(missionId: string): Promise<WorkItem[]> {
    if (this.projections) return this.projections.listWorkItems(missionId);
    const map = new Map<string, WorkItem>();
    for (const event of await this.store.list(missionId)) {
      const payload = event.payload as any;
      if (event.type === "work.created" && payload.work) map.set(payload.work.id, payload.work as WorkItem);
      const work = payload.id ? map.get(payload.id) : undefined;
      if (!work) continue;
      if (event.type === "work.started") work.status = "running";
      if (event.type === "work.updated") work.status = payload.status;
      if (event.type === "work.completed") work.status = "succeeded";
      if (event.type === "work.failed") work.status = "failed";
      if (event.type === "work.blocked") work.status = "blocked";
      if (event.type === "work.invalidated") work.status = "invalidated";
    }
    return [...map.values()];
  }

  async openGaps(missionId: string): Promise<Gap[]> {
    if (this.projections) return (await this.projections.listGaps(missionId)).filter(isOpenGap);
    const map = new Map<string, Gap>();
    for (const event of await this.store.list(missionId)) {
      const payload = event.payload as any;
      if (event.type === "gap.opened") {
        map.set(payload.id, {
          id: payload.id,
          missionId,
          category: payload.category ?? "quality",
          severity: payload.severity,
          description: payload.description ?? "Unspecified mission gap",
          findingRefs: payload.findingRefs ?? [],
          requirementRefs: payload.requirementRefs ?? [],
          artifactRefs: payload.artifactRefs ?? [],
          status: "open",
          openedAt: event.createdAt
        });
      }
      if ((event.type === "gap.resolved" || event.type === "gap.accepted") && map.has(payload.id)) {
        map.get(payload.id)!.status = event.type === "gap.resolved" ? "resolved" : "accepted";
      }
    }
    return [...map.values()].filter(isOpenGap);
  }

  async findings(missionId: string): Promise<Finding[]> {
    if (this.projections) return this.projections.listFindings(missionId);
    return (await this.store.list(missionId))
      .filter(event => event.type === "finding.created")
      .map(event => (((event.payload as any).finding ?? event.payload) as Finding));
  }

  async acceptanceContract(missionId: string): Promise<AcceptanceContract | null> {
    if (this.projections) return this.projections.getAcceptanceContract(missionId);
    const events = await this.store.list(missionId);
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (event.type !== "acceptance.created" && event.type !== "acceptance.revised") continue;
      const payload = event.payload as any;
      const contract = payload.contract ?? payload;
      return {
        missionId,
        revision: contract.revision ?? 1,
        requirements: contract.requirements ?? [],
        requiredArtifacts: contract.requiredArtifacts ?? [],
        requiredValidations: contract.requiredValidations ?? [],
        criticalFailureConditions: contract.criticalFailureConditions ?? [],
        completionPolicy: contract.completionPolicy,
        createdAt: contract.createdAt ?? event.createdAt
      };
    }
    return null;
  }

  async requirements(missionId: string): Promise<Requirement[]> {
    if (this.projections) return this.projections.listRequirements(missionId);
    const contract = await this.acceptanceContract(missionId);
    const requirements = new Map((contract?.requirements ?? []).map(item => [item.id, { ...item, evidenceRefs: [...item.evidenceRefs] }]));
    for (const event of await this.store.list(missionId)) {
      if (event.type !== "requirement.status.changed") continue;
      const payload = event.payload as any;
      const requirement = requirements.get(payload.id);
      if (!requirement) continue;
      requirement.status = payload.status;
      requirement.evidenceRefs = [...new Set([...requirement.evidenceRefs, ...(payload.evidenceRefs ?? [])])];
    }
    return [...requirements.values()];
  }

  async artifacts(missionId: string): Promise<Artifact[]> {
    if (this.projections) return this.projections.listArtifacts(missionId);
    const artifacts = new Map<string, Artifact>();
    for (const event of await this.store.list(missionId)) {
      const payload = event.payload as any;
      if (event.type === "artifact.created" && payload.artifact) artifacts.set(`${payload.artifact.id}@${payload.artifact.version}`, { ...payload.artifact });
      if ((event.type === "artifact.validated" || event.type === "artifact.invalidated") && payload.artifactRef) {
        const artifact = artifacts.get(payload.artifactRef);
        if (artifact) artifact.status = event.type === "artifact.invalidated" ? "invalid" : payload.final ? "final" : "verified";
      }
    }
    return [...artifacts.values()];
  }

  async evidence(missionId: string): Promise<Evidence[]> {
    if (this.projections) return this.projections.listEvidence(missionId);
    return (await this.store.list(missionId)).filter(e => e.type === "evidence.created").map(e => ((e.payload as any).evidence ?? e.payload) as Evidence);
  }

  async verifications(missionId: string): Promise<VerificationResult[]> {
    if (this.projections) return this.projections.listVerificationResults(missionId);
    return (await this.store.list(missionId)).filter(e => e.type === "verification.completed").map(e => ((e.payload as any).verification ?? e.payload) as VerificationResult);
  }
}

function isOpenGap(gap: Gap): boolean {
  return gap.status === "open" || gap.status === "working" || gap.status === "blocked";
}
