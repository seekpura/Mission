import type { MissionEvent } from "../../core/domain/event.ts";
import type { InvocationReceipt } from "../../core/domain/invocation.ts";
import type { AuditRecord, CapabilityTrustProfile, CompletionRecord, CostEvent } from "../../core/domain/governance.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { MissionDatabase } from "./database.ts";

export class SqliteGovernanceProjector {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) { this.database = database; }

  apply(event: MissionEvent): void {
    const payload = event.payload as any;
    if (event.type === "execution.invocation.recorded") {
      const receipt = (payload.receipt ?? payload) as InvocationReceipt;
      if (!receipt?.id) return;
      this.recordInvocationCost(receipt, event.createdAt);
      this.updateCapabilityTrust(receipt, event.createdAt);
      if (receipt.sideEffects.length > 0) {
        this.recordAudit({
          id: `audit:${event.id}`,
          missionId: event.missionId,
          action: "external.side_effect.executed",
          actorType: event.actor.type,
          actorId: event.actor.id,
          target: receipt.targetRef,
          authorizationRefs: receipt.approvalRef ? [receipt.approvalRef] : [],
          evidenceRefs: [receipt.id],
          data: { executionId: receipt.executionId, route: receipt.route, sideEffects: receipt.sideEffects },
          createdAt: event.createdAt
        });
      }
      return;
    }

    if (event.type === "approval.requested" || event.type === "approval.decided") {
      this.recordAudit({
        id: `audit:${event.id}`,
        missionId: event.missionId,
        action: event.type,
        actorType: event.actor.type,
        actorId: event.actor.id,
        target: payload.target ?? payload.requestedAction ?? payload.id,
        authorizationRefs: payload.id ? [String(payload.id)] : [],
        evidenceRefs: [],
        data: payload && typeof payload === "object" ? payload : { value: payload },
        createdAt: event.createdAt
      });
      return;
    }

    if (event.type === "capability.activated" || event.type === "capability.invalidated") {
      const capability = payload.capability ?? payload;
      this.recordAudit({
        id: `audit:${event.id}`,
        missionId: event.missionId,
        action: event.type,
        actorType: event.actor.type,
        actorId: event.actor.id,
        target: capability.id ?? payload.id ?? payload.capabilityRef,
        authorizationRefs: payload.approvalRef ? [payload.approvalRef] : [],
        evidenceRefs: payload.receiptRef ? [payload.receiptRef] : [],
        data: payload && typeof payload === "object" ? payload : { value: payload },
        createdAt: event.createdAt
      });
      return;
    }

    if (event.type === "mission.completed") {
      this.recordAudit({
        id: `audit:${event.id}`,
        missionId: event.missionId,
        action: "mission.completed",
        actorType: event.actor.type,
        actorId: event.actor.id,
        target: event.missionId,
        authorizationRefs: [],
        evidenceRefs: [],
        data: payload && typeof payload === "object" ? payload : { value: payload },
        createdAt: event.createdAt
      });
      this.recordCompletion(event);
    }
  }

  private recordInvocationCost(receipt: InvocationReceipt, createdAt: string): void {
    const start = Date.parse(receipt.startedAt);
    const end = Date.parse(receipt.endedAt);
    const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : 0;
    const wallTime: CostEvent = {
      id: `cost:${receipt.executionId}:wall-time`, missionId: receipt.missionId,
      workItemId: receipt.workItemId, attemptId: receipt.attemptId, executionId: receipt.executionId,
      category: "wall_time", quantity: duration, unit: "ms", source: "invocation_receipt", createdAt
    };
    this.insertCost(wallTime);
    if (receipt.sideEffects.length > 0) {
      this.insertCost({
        id: `cost:${receipt.executionId}:side-effects`, missionId: receipt.missionId,
        workItemId: receipt.workItemId, attemptId: receipt.attemptId, executionId: receipt.executionId,
        category: "external_side_effect", quantity: receipt.sideEffects.length, unit: "actions",
        source: "invocation_receipt", createdAt
      });
    }
  }

  private insertCost(cost: CostEvent): void {
    this.database.db.prepare(`INSERT OR REPLACE INTO cost_events
      (id, mission_id, work_item_id, execution_id, category, quantity, unit, monetary_estimate, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(cost.id, cost.missionId, cost.workItemId ?? null, cost.executionId ?? null, cost.category,
        cost.quantity, cost.unit, cost.monetaryEstimate ?? null, JSON.stringify(cost), cost.createdAt);
  }

  private recordAudit(record: AuditRecord): void {
    this.database.db.prepare(`INSERT OR REPLACE INTO audit_records
      (id, mission_id, action, actor_type, target, data_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(record.id, record.missionId, record.action, record.actorType, record.target ?? null, JSON.stringify(record), record.createdAt);
  }

  private updateCapabilityTrust(receipt: InvocationReceipt, observedAt: string): void {
    const refs = new Set(receipt.capabilityRefs);
    if (receipt.route === "host_capability" && receipt.targetRef) refs.add(receipt.targetRef);
    if (refs.size === 0) return;
    const row = this.database.db.prepare("SELECT data_json FROM work_items WHERE id = ? AND mission_id = ?")
      .get(receipt.workItemId, receipt.missionId) as { data_json: string } | undefined;
    const purpose = row ? (JSON.parse(row.data_json) as WorkItem).purpose : "unknown";
    const start = Date.parse(receipt.startedAt);
    const end = Date.parse(receipt.endedAt);
    const duration = Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : undefined;
    for (const capabilityId of refs) {
      const existing = this.database.db.prepare("SELECT data_json FROM capability_trust WHERE mission_id = ? AND capability_id = ? AND purpose = ?")
        .get(receipt.missionId, capabilityId, purpose) as { data_json: string } | undefined;
      const current: CapabilityTrustProfile = existing ? JSON.parse(existing.data_json) : {
        missionId: receipt.missionId, capabilityId, purpose, attempts: 0, succeeded: 0, failed: 0,
        cancelled: 0, successRate: 0, lastObservedAt: observedAt
      };
      const attemptsBefore = current.attempts;
      current.attempts += 1;
      if (receipt.result === "succeeded") current.succeeded += 1;
      else if (receipt.result === "cancelled") current.cancelled += 1;
      else current.failed += 1;
      current.successRate = current.attempts > 0 ? current.succeeded / current.attempts : 0;
      if (duration !== undefined) {
        current.averageWallTimeMs = current.averageWallTimeMs === undefined
          ? duration
          : ((current.averageWallTimeMs * attemptsBefore) + duration) / current.attempts;
      }
      current.lastObservedAt = observedAt;
      this.database.db.prepare(`INSERT INTO capability_trust
        (mission_id, capability_id, purpose, attempts, succeeded, failed, data_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mission_id, capability_id, purpose) DO UPDATE SET
          attempts = excluded.attempts, succeeded = excluded.succeeded, failed = excluded.failed,
          data_json = excluded.data_json, updated_at = excluded.updated_at`)
        .run(current.missionId, current.capabilityId, current.purpose, current.attempts, current.succeeded,
          current.failed, JSON.stringify(current), observedAt);
    }
  }

  private recordCompletion(event: MissionEvent): void {
    const db = this.database.db;
    const requirementRows = db.prepare("SELECT priority, status FROM requirements WHERE mission_id = ?").all(event.missionId) as Array<{ priority: string; status: string }>;
    const critical = requirementRows.filter(row => row.priority === "critical");
    const required = requirementRows.filter(row => row.priority === "required");
    const gapRows = db.prepare("SELECT id, severity, status FROM gaps WHERE mission_id = ?").all(event.missionId) as Array<{ id: string; severity: string; status: string }>;
    const blockingGapRefs = gapRows.filter(row => ["critical", "major"].includes(row.severity) && ["open", "working", "blocked"].includes(row.status)).map(row => row.id);
    const artifactRows = db.prepare("SELECT id, version, status FROM artifacts WHERE mission_id = ?").all(event.missionId) as Array<{ id: string; version: number; status: string }>;
    const finalArtifactRefs = artifactRows.filter(row => row.status === "final").map(row => `${row.id}@${row.version}`);
    const verificationCount = Number((db.prepare("SELECT COUNT(*) AS n FROM verification_results WHERE mission_id = ?").get(event.missionId) as { n: number }).n);
    const totalObservedWallTimeMs = Number((db.prepare("SELECT COALESCE(SUM(quantity), 0) AS n FROM cost_events WHERE mission_id = ? AND category = 'wall_time'").get(event.missionId) as { n: number }).n);
    const advisoryRows = db.prepare("SELECT data_json FROM findings WHERE mission_id = ? AND severity = 'advisory'").all(event.missionId) as Array<{ data_json: string }>;
    const unresolvedAdvisories = advisoryRows.map(row => {
      const finding = JSON.parse(row.data_json) as { observation?: string };
      return finding.observation ?? "advisory finding";
    });
    const record: CompletionRecord = {
      missionId: event.missionId,
      missionRevision: event.sequence,
      completedAt: event.createdAt,
      finalArtifactRefs,
      criticalRequirementsSatisfied: critical.filter(row => row.status === "satisfied").length,
      criticalRequirementsTotal: critical.length,
      requiredRequirementsSatisfied: required.filter(row => row.status === "satisfied").length,
      requiredRequirementsTotal: required.length,
      blockingGapRefs,
      verificationCount,
      totalObservedWallTimeMs,
      unresolvedAdvisories,
      completionEventRef: event.id
    };
    db.prepare(`INSERT INTO completion_records (mission_id, mission_revision, data_json, completed_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(mission_id, mission_revision) DO UPDATE SET data_json = excluded.data_json, completed_at = excluded.completed_at`)
      .run(record.missionId, record.missionRevision, JSON.stringify(record), record.completedAt);
  }
}
