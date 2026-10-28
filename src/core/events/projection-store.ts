import type { Artifact } from "../domain/artifact.ts";
import type { AcquisitionReceipt, CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import type { MissionEvent } from "../domain/event.ts";
import type { InvocationReceipt } from "../domain/invocation.ts";
import type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";
import type { AuditRecord, CapabilityTrustProfile, CompletionRecord, CostEvent } from "../domain/governance.ts";
import type { AcceptanceContract, MissionSpec, MissionState, Requirement } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Evidence, Finding, Gap, VerificationResult } from "../domain/verification.ts";

export interface MissionProjectionReader {
  getMissionState(missionId: string): Promise<MissionState | null>;
  getMissionSpec(missionId: string): Promise<MissionSpec | null>;
  getAcceptanceContract(missionId: string): Promise<AcceptanceContract | null>;
  listRequirements(missionId: string): Promise<Requirement[]>;
  listEvidence(missionId: string): Promise<Evidence[]>;
  listSources(missionId: string): Promise<SourceRecord[]>;
  listTruths(missionId: string): Promise<TruthRecord[]>;
  listArtifacts(missionId: string): Promise<Artifact[]>;
  listCapabilityNeeds(missionId: string): Promise<CapabilityNeed[]>;
  listCapabilities(missionId: string): Promise<CapabilityDescriptor[]>;
  listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]>;
  listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]>;
  listCostEvents(missionId: string): Promise<CostEvent[]>;
  listAuditRecords(missionId: string): Promise<AuditRecord[]>;
  listCapabilityTrustProfiles(missionId: string): Promise<CapabilityTrustProfile[]>;
  listCompletionRecords(missionId: string): Promise<CompletionRecord[]>;
  listVerificationResults(missionId: string): Promise<VerificationResult[]>;
  listWorkItems(missionId: string): Promise<WorkItem[]>;
  listFindings(missionId: string): Promise<Finding[]>;
  listGaps(missionId: string): Promise<Gap[]>;
}

export interface MissionProjectionWriter {
  apply(event: MissionEvent): void;
  rebuild(missionId: string, events: MissionEvent[]): void;
}
