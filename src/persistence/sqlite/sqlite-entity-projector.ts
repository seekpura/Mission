import type { Artifact } from "../../core/domain/artifact.ts";
import type { AcquisitionReceipt, CapabilityCandidate, CapabilityDescriptor, CapabilityNeed } from "../../core/domain/capability.ts";
import type { MissionEvent } from "../../core/domain/event.ts";
import type { InvocationReceipt } from "../../core/domain/invocation.ts";
import type { AcceptanceContract, MissionSpec, Requirement } from "../../core/domain/mission.ts";
import type { WorkItem } from "../../core/domain/work-item.ts";
import type { Evidence, Gap, VerificationResult } from "../../core/domain/verification.ts";
import type { MissionDatabase } from "./database.ts";

export class SqliteEntityProjector {
  private readonly database: MissionDatabase;

  constructor(database: MissionDatabase) { this.database = database; }

  apply(event: MissionEvent): void {
    const db = this.database.db;
    const payload = event.payload as any;
    switch (event.type) {
      case "mission.spec.revised": {
        const spec = payload.spec ?? payload;
        if (!spec?.revision) return;
        const normalized = { missionId: event.missionId, requestedOutputs: [], constraints: [], preferences: [], sourceRefs: [], createdAt: event.createdAt, ...spec } as MissionSpec;
        db.prepare(`INSERT OR REPLACE INTO mission_specs (mission_id, revision, data_json, created_at) VALUES (?, ?, ?, ?)`)
          .run(event.missionId, normalized.revision, JSON.stringify(normalized), normalized.createdAt);
        return;
      }
      case "acceptance.created":
      case "acceptance.revised": {
        const contract = (payload.contract ?? payload) as AcceptanceContract;
        if (!contract?.revision) return;
        const normalized: AcceptanceContract = {
          missionId: event.missionId,
          revision: contract.revision,
          requirements: contract.requirements ?? [],
          requiredArtifacts: contract.requiredArtifacts ?? [],
          requiredValidations: contract.requiredValidations ?? [],
          criticalFailureConditions: contract.criticalFailureConditions ?? [],
          completionPolicy: contract.completionPolicy,
          createdAt: contract.createdAt ?? event.createdAt
        };
        db.prepare(`INSERT OR REPLACE INTO acceptance_contracts (mission_id, revision, data_json, created_at) VALUES (?, ?, ?, ?)`)
          .run(event.missionId, normalized.revision, JSON.stringify(normalized), normalized.createdAt);
        db.prepare("DELETE FROM requirements WHERE mission_id = ?").run(event.missionId);
        const insert = db.prepare(`INSERT INTO requirements (id, mission_id, contract_revision, status, priority, type, description, data_json, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
        for (const requirement of normalized.requirements) {
          insert.run(requirement.id, event.missionId, normalized.revision, requirement.status, requirement.priority, requirement.type, requirement.description, JSON.stringify(requirement), event.createdAt);
        }
        return;
      }
      case "requirement.status.changed": {
        const row = db.prepare("SELECT data_json FROM requirements WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const requirement = JSON.parse(row.data_json) as Requirement;
        requirement.status = payload.status;
        if (Array.isArray(payload.evidenceRefs)) requirement.evidenceRefs = [...new Set([...(requirement.evidenceRefs ?? []), ...payload.evidenceRefs])];
        db.prepare("UPDATE requirements SET status = ?, data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")
          .run(requirement.status, JSON.stringify(requirement), event.createdAt, requirement.id, event.missionId);
        return;
      }
      case "evidence.created": {
        const evidence = (payload.evidence ?? payload) as Evidence;
        if (!evidence?.id) return;
        db.prepare(`INSERT OR REPLACE INTO evidence (id, mission_id, subject_ref, type, result, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(evidence.id, event.missionId, evidence.subjectRef, evidence.type, evidence.result, JSON.stringify(evidence), evidence.createdAt ?? event.createdAt);
        return;
      }
      case "verification.completed": {
        const verification = (payload.verification ?? payload) as VerificationResult;
        if (!verification?.id) return;
        db.prepare(`INSERT OR REPLACE INTO verification_results (id, mission_id, artifact_ref, level, overall, profile_id, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(verification.id, event.missionId, verification.artifactRef, verification.level, verification.overall, verification.verificationProfileId, JSON.stringify(verification), verification.createdAt ?? event.createdAt);
        return;
      }
      case "artifact.created": {
        const artifact = (payload.artifact ?? payload) as Artifact;
        if (!artifact?.id || !artifact?.version) return;
        db.prepare(`INSERT OR REPLACE INTO artifacts
          (id, mission_id, logical_name, type, version, status, uri, content_hash, produced_by_attempt_id, metadata_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(artifact.id, event.missionId, artifact.logicalName, artifact.type, artifact.version, artifact.status, artifact.uri, artifact.contentHash, artifact.producedByAttemptId, JSON.stringify(artifact), artifact.createdAt ?? event.createdAt);
        return;
      }
      case "artifact.validated": {
        const ref = String(payload.artifactRef ?? "");
        const [id, versionText] = ref.split("@");
        const version = Number(versionText);
        if (!id || !Number.isFinite(version)) return;
        const row = db.prepare("SELECT metadata_json FROM artifacts WHERE id = ? AND version = ? AND mission_id = ?").get(id, version, event.missionId) as { metadata_json: string } | undefined;
        if (!row) return;
        const artifact = JSON.parse(row.metadata_json) as Artifact;
        artifact.status = payload.final ? "final" : "verified";
        db.prepare("UPDATE artifacts SET status = ?, metadata_json = ? WHERE id = ? AND version = ? AND mission_id = ?")
          .run(artifact.status, JSON.stringify(artifact), id, version, event.missionId);
        return;
      }
      case "artifact.invalidated": {
        const ref = String(payload.artifactRef ?? "");
        const [id, versionText] = ref.split("@");
        const version = Number(versionText);
        if (!id || !Number.isFinite(version)) return;
        const row = db.prepare("SELECT metadata_json FROM artifacts WHERE id = ? AND version = ? AND mission_id = ?").get(id, version, event.missionId) as { metadata_json: string } | undefined;
        if (!row) return;
        const artifact = JSON.parse(row.metadata_json) as Artifact;
        artifact.status = "invalid";
        db.prepare("UPDATE artifacts SET status = 'invalid', metadata_json = ? WHERE id = ? AND version = ? AND mission_id = ?")
          .run(JSON.stringify(artifact), id, version, event.missionId);
        return;
      }
      case "work.created": {
        const work = (payload.work ?? payload) as WorkItem;
        if (!work?.id) return;
        db.prepare(`INSERT INTO work_items
          (id, mission_id, status, purpose, priority, graph_revision, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            status = excluded.status,
            purpose = excluded.purpose,
            priority = excluded.priority,
            graph_revision = excluded.graph_revision,
            data_json = excluded.data_json,
            updated_at = excluded.updated_at`)
          .run(work.id, work.missionId, work.status, work.purpose, work.priority, work.graphRevision, JSON.stringify(work), work.createdAt, work.updatedAt);
        return;
      }
      case "work.started":
        this.updateWork(payload.id, "running", event.createdAt);
        return;
      case "work.updated":
        this.updateWork(payload.id, payload.status, event.createdAt);
        return;
      case "work.completed":
        this.updateWork(payload.id, "succeeded", event.createdAt);
        return;
      case "work.failed":
        this.updateWork(payload.id, "failed", event.createdAt);
        return;
      case "work.blocked":
        this.updateWork(payload.id, "blocked", event.createdAt);
        return;
      case "work.invalidated":
        this.updateWork(payload.id, "invalidated", event.createdAt);
        return;
      case "gap.opened": {
        const gap: Gap = {
          id: payload.id,
          missionId: event.missionId,
          category: payload.category ?? "quality",
          severity: payload.severity,
          description: payload.description ?? "Unspecified mission gap",
          findingRefs: payload.findingRefs ?? [],
          requirementRefs: payload.requirementRefs ?? [],
          artifactRefs: payload.artifactRefs ?? [],
          status: "open",
          openedAt: payload.openedAt ?? event.createdAt
        };
        db.prepare(`INSERT INTO gaps
          (id, mission_id, category, severity, status, description, data_json, opened_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET
            category = excluded.category,
            severity = excluded.severity,
            status = excluded.status,
            description = excluded.description,
            data_json = excluded.data_json`)
          .run(gap.id, gap.missionId, gap.category, gap.severity, gap.status, gap.description, JSON.stringify(gap), gap.openedAt);
        return;
      }
      case "gap.resolved":
      case "gap.accepted": {
        const row = db.prepare("SELECT data_json FROM gaps WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const gap = JSON.parse(row.data_json) as Gap;
        gap.status = event.type === "gap.resolved" ? "resolved" : "accepted";
        gap.resolvedAt = event.createdAt;
        db.prepare("UPDATE gaps SET status = ?, data_json = ?, resolved_at = ? WHERE id = ? AND mission_id = ?")
          .run(gap.status, JSON.stringify(gap), event.createdAt, gap.id, event.missionId);
        return;
      }
      case "decision.created": {
        const decision = payload.decision ?? payload;
        if (!decision?.id) return;
        db.prepare(`INSERT INTO decisions (id, mission_id, type, status, rationale, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, rationale = excluded.rationale, data_json = excluded.data_json`)
          .run(decision.id, event.missionId, decision.type, decision.status ?? "proposed", decision.rationale ?? "", JSON.stringify(decision), decision.createdAt ?? event.createdAt);
        return;
      }
      case "decision.applied":
        if (payload.id) db.prepare("UPDATE decisions SET status = 'applied' WHERE id = ? AND mission_id = ?").run(payload.id, event.missionId);
        return;
      case "approval.requested": {
        if (!payload.id) return;
        db.prepare(`INSERT INTO approvals (id, mission_id, status, scope, request_json, result_json, requested_at, decided_at)
          VALUES (?, ?, 'pending', ?, ?, NULL, ?, NULL)
          ON CONFLICT(id) DO UPDATE SET status = 'pending', request_json = excluded.request_json`)
          .run(payload.id, event.missionId, payload.scope ?? "once", JSON.stringify(payload), event.createdAt);
        return;
      }
      case "approval.decided":
        if (payload.id) db.prepare("UPDATE approvals SET status = ?, result_json = ?, decided_at = ? WHERE id = ? AND mission_id = ?")
          .run(payload.approved ? "approved" : "rejected", JSON.stringify(payload), event.createdAt, payload.id, event.missionId);
        return;
      case "execution.invocation.recorded": {
        const receipt = (payload.receipt ?? payload) as InvocationReceipt;
        if (!receipt?.id) return;
        db.prepare(`INSERT OR REPLACE INTO invocation_receipts
          (id, mission_id, work_item_id, execution_id, route, result, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)` )
          .run(receipt.id, event.missionId, receipt.workItemId, receipt.executionId, receipt.route, receipt.result, JSON.stringify(receipt), receipt.createdAt ?? event.createdAt);
        return;
      }
      case "capability.need.created": {
        const need = (payload.need ?? payload) as CapabilityNeed;
        if (!need?.id) return;
        const normalized: CapabilityNeed = { ...need, missionId: event.missionId, status: need.status ?? "checking-installed" };
        db.prepare(`INSERT INTO capability_needs (id, mission_id, status, urgency, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, urgency = excluded.urgency, data_json = excluded.data_json, updated_at = excluded.updated_at`)
          .run(normalized.id, event.missionId, normalized.status, normalized.urgency, JSON.stringify(normalized), event.createdAt, event.createdAt);
        return;
      }
      case "capability.need.updated": {
        const row = db.prepare("SELECT data_json FROM capability_needs WHERE id = ? AND mission_id = ?").get(payload.id, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const need = JSON.parse(row.data_json) as CapabilityNeed;
        if (payload.status) need.status = payload.status;
        if (payload.resolvedCapabilityRef) need.resolvedCapabilityRef = payload.resolvedCapabilityRef;
        db.prepare("UPDATE capability_needs SET status = ?, data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")
          .run(need.status ?? "unresolved", JSON.stringify(need), event.createdAt, need.id, event.missionId);
        return;
      }
      case "capability.candidate.discovered":
      case "capability.candidate.materialized":
      case "capability.candidate.scanned":
      case "capability.candidate.sandboxed":
      case "capability.rejected": {
        const candidate = (payload.candidate ?? payload) as CapabilityCandidate;
        const candidateId = candidate?.id ?? payload.candidateId;
        if (!candidateId) return;
        const existing = db.prepare("SELECT data_json FROM capability_candidates WHERE id = ?").get(candidateId) as { data_json: string } | undefined;
        const current = existing ? JSON.parse(existing.data_json) : {};
        const merged = { ...current, ...candidate, ...payload, id: candidateId };
        const status = event.type === "capability.rejected" ? "rejected"
          : event.type === "capability.candidate.materialized" ? "quarantined"
          : event.type === "capability.candidate.sandboxed" && payload.sandbox?.passed ? "verified"
          : merged.status ?? "discovered";
        merged.status = status;
        db.prepare(`INSERT INTO capability_candidates (id, mission_id, need_id, status, source_type, source_uri, revision, data_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json, updated_at = excluded.updated_at`)
          .run(candidateId, event.missionId, payload.needId ?? merged.needId ?? "", status, merged.sourceType ?? "other", merged.sourceUri ?? "", merged.resolvedRevision ?? null, JSON.stringify(merged), event.createdAt, event.createdAt);
        return;
      }
      case "capability.acquisition.receipt": {
        const receipt = (payload.receipt ?? payload) as AcquisitionReceipt;
        if (!receipt?.id) return;
        db.prepare(`INSERT OR REPLACE INTO acquisition_receipts (id, mission_id, need_id, candidate_id, status, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(receipt.id, event.missionId, receipt.capabilityNeedRef, receipt.candidateId, receipt.status, JSON.stringify(receipt), receipt.createdAt ?? event.createdAt);
        return;
      }
      case "capability.invalidated": {
        const capabilityId = payload.id ?? payload.capabilityRef;
        if (!capabilityId) return;
        const row = db.prepare("SELECT data_json FROM capabilities WHERE id = ? AND mission_id = ?").get(capabilityId, event.missionId) as { data_json: string } | undefined;
        if (!row) return;
        const capability = JSON.parse(row.data_json) as CapabilityDescriptor;
        capability.available = false;
        capability.metadata = { ...(capability.metadata ?? {}), invalidatedAt: event.createdAt, invalidationReason: payload.reason };
        db.prepare("UPDATE capabilities SET status = 'unavailable', data_json = ? WHERE id = ? AND mission_id = ?")
          .run(JSON.stringify(capability), capabilityId, event.missionId);
        return;
      }
      case "capability.activated": {
        const capability = (payload.capability ?? payload) as CapabilityDescriptor;
        if (!capability?.id) return;
        db.prepare(`INSERT INTO capabilities (id, mission_id, scope, kind, status, source_uri, revision, data_json, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET status = excluded.status, revision = excluded.revision, data_json = excluded.data_json`)
          .run(capability.id, event.missionId, capability.scope ?? "mission", capability.kind ?? "tool", capability.available === false ? "unavailable" : "available", capability.sourceUri ?? null, capability.revision ?? null, JSON.stringify(capability), event.createdAt);
        if (payload.needId) {
          const needRow = db.prepare("SELECT data_json FROM capability_needs WHERE id = ? AND mission_id = ?").get(payload.needId, event.missionId) as { data_json: string } | undefined;
          if (needRow) {
            const need = JSON.parse(needRow.data_json) as CapabilityNeed;
            need.status = "available"; need.resolvedCapabilityRef = capability.id;
            db.prepare("UPDATE capability_needs SET status = 'available', data_json = ?, updated_at = ? WHERE id = ? AND mission_id = ?")
              .run(JSON.stringify(need), event.createdAt, need.id, event.missionId);
          }
        }
        return;
      }
    }
  }

  private updateWork(id: string | undefined, status: WorkItem["status"], updatedAt: string): void {
    if (!id) return;
    const row = this.database.db.prepare("SELECT data_json FROM work_items WHERE id = ?").get(id) as { data_json: string } | undefined;
    if (!row) return;
    const work = JSON.parse(row.data_json) as WorkItem;
    work.status = status;
    work.updatedAt = updatedAt;
    this.database.db.prepare("UPDATE work_items SET status = ?, data_json = ?, updated_at = ? WHERE id = ?")
      .run(status, JSON.stringify(work), updatedAt, id);
  }
}
