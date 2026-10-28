import type { CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionProjectionReader } from "../../core/events/projection-store.ts";
import type { MissionController } from "../../core/mission/controller.ts";
import { CapabilityResolver } from "../../core/capabilities/resolver.ts";
import type { SecureAcquisitionService } from "../../core/capabilities/secure-acquisition-service.ts";
import type { HostAdapter } from "../../hosts/deepseek/host-adapter.ts";
import type { VerificationContinuationService } from "./verification-continuation-service.ts";

export interface WorkCapabilityPreparation {
  status: "ready" | "acquisition_scheduled" | "blocked" | "handled";
  capabilities: CapabilityDescriptor[];
  missingNeeds: CapabilityNeed[];
}

export class CapabilityCoordinator {
  private readonly controller: MissionController;
  private readonly projections: MissionProjectionReader;
  private readonly host: HostAdapter;
  private readonly resolver: CapabilityResolver;
  private readonly acquisition?: SecureAcquisitionService;
  private readonly verificationContinuation?: VerificationContinuationService;

  constructor(input: {
    controller: MissionController;
    projections: MissionProjectionReader;
    host: HostAdapter;
    acquisition?: SecureAcquisitionService;
    resolver?: CapabilityResolver;
    verificationContinuation?: VerificationContinuationService;
  }) {
    this.controller = input.controller;
    this.projections = input.projections;
    this.host = input.host;
    this.acquisition = input.acquisition;
    this.resolver = input.resolver ?? new CapabilityResolver();
    this.verificationContinuation = input.verificationContinuation;
  }

  async prepare(work: WorkItem): Promise<WorkCapabilityPreparation> {
    if (work.purpose === "acquisition" || work.capabilityNeedRefs.length === 0) return { status: "ready", capabilities: [], missingNeeds: [] };
    const [environment, missionCapabilities, needs] = await Promise.all([
      this.host.snapshotEnvironment(),
      this.projections.listCapabilities(work.missionId),
      this.projections.listCapabilityNeeds(work.missionId)
    ]);
    const excludedCapabilityRefs = new Set(work.executionConstraints?.excludeCapabilityRefs ?? []);
    const effective = mergeCapabilities(environment.capabilities, missionCapabilities)
      .filter(capability => !excludedCapabilityRefs.has(capability.id));
    const requestedIds = [...new Set([
      ...work.capabilityNeedRefs,
      ...(work.executionConstraints?.preferredCapabilityNeedRefs ?? [])
    ])];
    const requested = requestedIds.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);
    const capabilities: CapabilityDescriptor[] = [];
    const missingNeeds: CapabilityNeed[] = [];
    for (const need of requested) {
      const resolvedByRef = need.resolvedCapabilityRef && !excludedCapabilityRefs.has(need.resolvedCapabilityRef)
        ? effective.find(cap => cap.id === need.resolvedCapabilityRef && cap.available)
        : undefined;
      if (resolvedByRef) { capabilities.push(resolvedByRef); continue; }
      const resolution = this.resolver.resolve(need, effective);
      if (resolution.status === "resolved" && resolution.capability) {
        capabilities.push(resolution.capability);
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "available", resolvedCapabilityRef: resolution.capability.id }, { type: "controller" }, `capability-need-resolved:${need.id}:${resolution.capability.id}`);
      } else {
        missingNeeds.push(need);
      }
    }
    if (missingNeeds.length === 0) {
      if (work.purpose === "verification" && this.verificationContinuation) {
        await this.verificationContinuation.resume(work);
        return { status: "handled", capabilities: uniqueCapabilities(capabilities), missingNeeds: [] };
      }
      return { status: "ready", capabilities: uniqueCapabilities(capabilities), missingNeeds: [] };
    }

    let scheduled = false;
    for (const need of missingNeeds) {
      if (!need.acquisitionAllowed || !this.acquisition) {
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "unresolved" }, { type: "controller" }, `capability-need-unresolved:${need.id}`);
        await this.controller.openGap(work.missionId, {
          id: `capability-${need.id}`,
          severity: need.urgency === "blocking" ? "major" : "minor",
          description: `Capability unavailable: ${need.objective}`,
          category: "capability",
          requirementRefs: need.requirementRefs,
          artifactRefs: work.inputArtifactRefs
        });
        continue;
      }
      const acquisitionId = `acquire-${need.id}`;
      const existing = (await this.projections.listWorkItems(work.missionId)).find(item => item.id === acquisitionId && !["succeeded", "invalidated", "abandoned", "superseded"].includes(item.status));
      if (!existing) {
        const now = new Date().toISOString();
        await this.controller.proposeWork({
          id: acquisitionId,
          missionId: work.missionId,
          workstreamId: work.workstreamId,
          parentWorkItemId: work.id,
          purpose: "acquisition",
          objective: `Acquire capability: ${need.objective}`,
          status: "ready",
          requirementRefs: need.requirementRefs,
          gapRefs: need.gapRefs,
          inputArtifactRefs: [],
          expectedOutputs: [],
          localAcceptanceCriteria: [{ id: `capability-ready-${need.id}`, description: `Capability ${need.id} is securely materialized, smoke-tested, and mission-local`, priority: "required" }],
          capabilityNeedRefs: [need.id],
          priority: need.urgency === "blocking" ? 100 : 60,
          graphRevision: work.graphRevision,
          createdBy: "system",
          createdAt: now,
          updatedAt: now
        });
        await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "discovering" }, { type: "controller" }, `capability-need-discovering:${need.id}`);
      }
      scheduled = true;
    }
    await this.controller.emit(work.missionId, "work.blocked", { id: work.id, reason: "waiting for required capability acquisition" }, { type: "controller" }, `work-capability-blocked:${work.id}`);
    return { status: scheduled ? "acquisition_scheduled" : "blocked", capabilities: [], missingNeeds };
  }

  async executeAcquisition(work: WorkItem): Promise<{ ok: boolean; capability?: CapabilityDescriptor; reason: string }> {
    const needId = work.capabilityNeedRefs[0];
    if (!needId || !this.acquisition) return { ok: false, reason: "Acquisition work has no configured acquisition service" };
    const need = (await this.projections.listCapabilityNeeds(work.missionId)).find(item => item.id === needId);
    if (!need) return { ok: false, reason: `CapabilityNeed not found: ${needId}` };
    await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "acquiring" }, { type: "controller" }, `capability-need-acquiring:${need.id}`);
    const outcome = await this.acquisition.acquire(need, {
      onTrace: async (type, payload) => {
        await this.controller.emit(work.missionId, type, payload, { type: "system" });
      },
      requestApproval: async ({ candidate, security }) => {
        const approvalId = `approval-capability-${candidate.id}`;
        await this.controller.emit(work.missionId, "approval.requested", { id: approvalId, scope: "mission", candidate, security }, { type: "controller" }, `approval-request:${approvalId}`);
        const result = await this.host.requestUserApproval({ missionId: work.missionId, title: `Enable ${candidate.name}`, reason: `Capability ${need.objective} requires approval`, details: { candidate, security } });
        await this.controller.emit(work.missionId, "approval.decided", { id: approvalId, approved: result.approved, scope: result.scope }, { type: "user" }, `approval-decision:${approvalId}`);
        return result.approved;
      }
    });
    if (!outcome.capability) {
      await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "unresolved" }, { type: "controller" }, `capability-need-failed:${need.id}:${outcome.receipt.id}`);
      return { ok: false, reason: outcome.receipt.sandbox.error ?? outcome.receipt.security.findings[0]?.detail ?? "Capability acquisition failed" };
    }
    await this.controller.emit(work.missionId, "capability.need.updated", { id: need.id, status: "available", resolvedCapabilityRef: outcome.capability.id }, { type: "controller" }, `capability-need-available:${need.id}:${outcome.capability.id}`);
    await this.unblockDependents(work.missionId, need.id);
    return { ok: true, capability: outcome.capability, reason: "Capability acquired" };
  }

  private async unblockDependents(missionId: string, _resolvedNeedId: string): Promise<void> {
    const [workItems, needs] = await Promise.all([this.projections.listWorkItems(missionId), this.projections.listCapabilityNeeds(missionId)]);
    for (const work of workItems.filter(item => item.status === "blocked" && item.purpose !== "acquisition")) {
      const requiredNeeds = work.capabilityNeedRefs.map(id => needs.find(need => need.id === id)).filter((need): need is CapabilityNeed => !!need);
      if (requiredNeeds.length > 0 && requiredNeeds.every(need => need.status === "available")) {
        await this.controller.emit(missionId, "work.updated", { id: work.id, status: "ready" }, { type: "controller" }, `work-capability-ready:${work.id}:${requiredNeeds.map(n => n.resolvedCapabilityRef).join(",")}`);
      }
    }
  }
}

function mergeCapabilities(...groups: CapabilityDescriptor[][]): CapabilityDescriptor[] {
  const map = new Map<string, CapabilityDescriptor>();
  for (const group of groups) for (const cap of group) map.set(cap.id, cap);
  return [...map.values()];
}
function uniqueCapabilities(values: CapabilityDescriptor[]): CapabilityDescriptor[] { return mergeCapabilities(values); }
