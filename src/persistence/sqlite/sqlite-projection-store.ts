import type { MissionEvent } from "../../core/domain/event.ts";
import type { InvocationReceipt } from "../../core/domain/invocation.ts";
import type { AcceptanceContract, MissionSpec, MissionState, Requirement } from "../../core/domain/mission.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { Evidence, Finding, Gap, VerificationResult } from "../../core/domain/verification.ts";
import type { Artifact } from "../../core/domain/artifact.ts";
import type { AcquisitionReceipt, CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import { applyMissionEvent, initialMissionState } from "../../core/events/state-projector.ts";
import type { MissionProjectionReader, MissionProjectionWriter } from "../../core/events/projection-store.ts";
import type { MissionDatabase } from "./database.ts";
import { SqliteEntityProjector } from "./sqlite-entity-projector.ts";

export class SqliteProjectionStore implements MissionProjectionReader, MissionProjectionWriter {
  private readonly database: MissionDatabase;
  private readonly entities: SqliteEntityProjector;
  constructor(database: MissionDatabase) { this.database = database; this.entities = new SqliteEntityProjector(database); }

  apply(event: MissionEvent): void {
    const db = this.database.db;
    const row = db.prepare("SELECT state_json FROM mission_states WHERE mission_id = ?").get(event.missionId) as { state_json: string } | undefined;
    const current = row ? JSON.parse(row.state_json) as MissionState : initialMissionState(event.missionId);
    const next = applyMissionEvent(current, event);

    db.prepare(`INSERT INTO mission_states (mission_id, event_sequence, state_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mission_id) DO UPDATE SET
        event_sequence = excluded.event_sequence,
        state_json = excluded.state_json,
        updated_at = excluded.updated_at`)
      .run(event.missionId, event.sequence, JSON.stringify(next), event.createdAt);

    db.prepare(`INSERT INTO missions (id, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        revision = excluded.revision,
        updated_at = excluded.updated_at`)
      .run(event.missionId, next.status, next.revision, next.createdAt ?? event.createdAt, event.createdAt);

    this.entities.apply(event);
  }

  rebuild(missionId: string, events: MissionEvent[]): void {
    const db = this.database.db;
    db.prepare("DELETE FROM mission_states WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM missions WHERE id = ?").run(missionId);
    db.prepare("DELETE FROM mission_specs WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM acceptance_contracts WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM requirements WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM evidence WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM verification_results WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM artifacts WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM work_items WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM findings WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM gaps WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM decisions WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM approvals WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM capabilities WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM capability_needs WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM capability_candidates WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM acquisition_receipts WHERE mission_id = ?").run(missionId);
    db.prepare("DELETE FROM invocation_receipts WHERE mission_id = ?").run(missionId);
    for (const event of events) this.apply(event);
  }

  async getMissionState(missionId: string): Promise<MissionState | null> {
    const row = this.database.db.prepare("SELECT state_json FROM mission_states WHERE mission_id = ?")
      .get(missionId) as { state_json: string } | undefined;
    return row ? JSON.parse(row.state_json) as MissionState : null;
  }

  async getMissionSpec(missionId: string): Promise<MissionSpec | null> {
    const row = this.database.db.prepare("SELECT data_json FROM mission_specs WHERE mission_id = ? ORDER BY revision DESC LIMIT 1")
      .get(missionId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as MissionSpec : null;
  }

  async getAcceptanceContract(missionId: string): Promise<AcceptanceContract | null> {
    const row = this.database.db.prepare("SELECT data_json FROM acceptance_contracts WHERE mission_id = ? ORDER BY revision DESC LIMIT 1")
      .get(missionId) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as AcceptanceContract : null;
  }

  async listRequirements(missionId: string): Promise<Requirement[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM requirements WHERE mission_id = ? ORDER BY id ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Requirement);
  }

  async listEvidence(missionId: string): Promise<Evidence[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM evidence WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Evidence);
  }

  async listArtifacts(missionId: string): Promise<Artifact[]> {
    const rows = this.database.db.prepare("SELECT metadata_json FROM artifacts WHERE mission_id = ? ORDER BY logical_name ASC, version ASC")
      .all(missionId) as Array<{ metadata_json: string }>;
    return rows.map(row => JSON.parse(row.metadata_json) as Artifact);
  }

  async listCapabilityNeeds(missionId: string): Promise<CapabilityNeed[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM capability_needs WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as CapabilityNeed);
  }

  async listCapabilities(missionId: string): Promise<CapabilityDescriptor[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM capabilities WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as CapabilityDescriptor);
  }

  async listAcquisitionReceipts(missionId: string): Promise<AcquisitionReceipt[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM acquisition_receipts WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as AcquisitionReceipt);
  }

  async listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM invocation_receipts WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as InvocationReceipt);
  }

  async listVerificationResults(missionId: string): Promise<VerificationResult[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM verification_results WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as VerificationResult);
  }

  async listWorkItems(missionId: string): Promise<WorkItem[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM work_items WHERE mission_id = ? ORDER BY priority DESC, created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as WorkItem);
  }

  async listFindings(missionId: string): Promise<Finding[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM findings WHERE mission_id = ? ORDER BY created_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Finding);
  }

  async listGaps(missionId: string): Promise<Gap[]> {
    const rows = this.database.db.prepare("SELECT data_json FROM gaps WHERE mission_id = ? ORDER BY opened_at ASC")
      .all(missionId) as Array<{ data_json: string }>;
    return rows.map(row => JSON.parse(row.data_json) as Gap);
  }

}