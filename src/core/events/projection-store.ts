import type { Artifact } from "../domain/artifact.ts";
import type { AcquisitionReceipt, CapabilityDescriptor, CapabilityNeed } from "../domain/capability.ts";
import type { MissionEvent } from "../domain/event.ts";
import type { AcceptanceContract, MissionSpec, MissionState, Requirement } from "../domain/mission.ts";
import type { WorkItem } from "../domain/work-item.ts";
import type { Evidence, Gap, VerificationResult } from "../domain/verification.ts";

export interface MissionProjectionReader {
  getMissionState(missionId: string): Promise<MissionState | null>;
  getMissionSpec(missionId: string): Promise<MissionSpec | null>;
  getAcceptanceContract(missionId: string): Promise<AcceptanceContract | null>;
  listRequirements(missionId: string): Promise<Requirement[]>;
  listEvidence(missionId: string): Promise<Evidence[]>;
  listArtifacts(missionId: string): Promise<Artifact[]>;
  listCapabilityNeeds(missionId: string): Promise<CapabilityNeed[]>;
  listCapabilities(missionId: string): Promise<CapabilityDescriptor[]>;
  listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]>;
  listVerificationResults(missionId: string): Promise<VerificationResult[]>;
  listWorkItems(missionId: string): Promise<WorkItem[]>;
  listGaps(missionId: string): Promise<Gap[]>;
}

export interface MissionProjectionWriter {
  apply(event: MissionEvent): void;
  rebuild(missionId: string, events: MissionEvent[]): void;
}
