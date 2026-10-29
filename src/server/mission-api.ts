import { createServer, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityAuditDecision, CapabilityCostRecord } from "../core/domain/capability-ledger.ts";
import type { SideEffectOperationStatus } from "../core/domain/execution.ts";
import type { Evidence } from "../core/domain/verification.ts";
import type { MissionController } from "../core/mission/controller.ts";
import type { EventStore } from "../core/events/event-store.ts";
import type { SqliteMissionHistoryReader } from "../persistence/sqlite/sqlite-mission-history-reader.ts";
import type { SqliteMissionReader } from "../persistence/sqlite/sqlite-mission-reader.ts";
import type { SqliteOperationalSummaryReader } from "../persistence/sqlite/sqlite-operational-summary-reader.ts";
import type { RuntimeApprovalManager } from "../runtime/approval-manager.ts";
import type { RuntimeCapabilityLifecycleManager } from "../runtime/capability-ledger-runtime.ts";
import type { MissionSupervisor } from "../runtime/mission-supervisor.ts";

const SIDE_EFFECT_STATUSES = new Set<SideEffectOperationStatus>([
  "pending",
  "admitted",
  "denied",
  "succeeded",
  "failed",
  "unknown"
]);
const APPROVAL_STATUSES = new Set(["pending", "approved", "rejected"] as const);
const EVIDENCE_KINDS = new Set<Evidence["kind"]>([
  "file-integrity",
  "text-content",
  "presentation-package",
  "presentation-render",
  "website-source",
  "browser-runtime",
  "accessibility-check",
  "media-probe",
  "media-playback",
  "code-source",
  "executable-test",
  "build-check",
  "integration-test",
  "static-analysis",
  "source-traceability",
  "source-recency"
]);
const EVIDENCE_RESULTS = new Set<Evidence["result"]>(["supports", "contradicts", "inconclusive"]);
const CAPABILITY_COST_PHASES = new Set<CapabilityCostRecord["phase"]>(["resolution", "acquisition", "activation"]);
const CAPABILITY_AUDIT_DECISIONS = new Set<CapabilityAuditDecision>([
  "existing-resolved",
  "acquired",
  "trusted-cache-reused",
  "deactivated",
  "revoked",
  "rejected"
]);

export interface MissionApiRuntime {
  supervisor?: MissionSupervisor;
  approvals?: RuntimeApprovalManager;
  approvalReader?: Pick<SqliteMissionReader, "readApprovals">;
  findingReader?: Pick<SqliteMissionReader, "readFindings">;
  capabilityLifecycle?: RuntimeCapabilityLifecycleManager;
  capabilityLedgerReader?: Pick<
    SqliteMissionReader,
    "readCapabilityTrustPage" | "readCapabilityCostsPage" | "readCapabilityAuditPage"
  >;
  evidenceReader?: Pick<SqliteMissionReader, "readEvidencePage">;
  sideEffectReader?: Pick<SqliteMissionReader, "readSideEffects">;
  operationalReader?: Pick<SqliteMissionReader, "readActivity" | "readAttempts" | "readExecutions">;
  summaryReader?: Pick<SqliteOperationalSummaryReader, "readSummary">;
  historyReader?: Pick<SqliteMissionHistoryReader, "readExportPage" | "readRetentionState">;
}

export interface MissionApiServer extends Server {
  beginDrain(): void;
  waitForRequestDrain(): Promise<void>;
  isDraining(): boolean;
}

export function createMissionApi(
  controller: MissionController,
  events: EventStore,
  runtime: MissionApiRuntime = {}
) {
  const subscribers = new Map<string, Set<ServerResponse>>();
  const activeRequests = new Set<ServerResponse>();
  const requestDrainWaiters = new Set<() => void>();
  let draining = false;

  function releaseRequest(res: ServerResponse): void {
    if (!activeRequests.delete(res)) return;
    if (activeRequests.size !== 0) return;
    for (const resolve of requestDrainWaiters) resolve();
    requestDrainWaiters.clear();
  }

  async function publish(missionId: string) {
    const latest = await controller.state(missionId);
    for (const res of subscribers.get(missionId) ?? []) {
      res.write(`event: mission.updated\ndata: ${JSON.stringify(latest)}\n\n`);
    }
  }

  const unsubscribeSupervisor = runtime.supervisor?.onUpdate(async missionId => {
    await publish(missionId);
  });

  const server = createServer(async (req, res) => {
    if (draining) return json(res, 503, { error: "runtime_draining" });
    activeRequests.add(res);
    res.once("finish", () => releaseRequest(res));
    res.once("close", () => releaseRequest(res));
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean).map(part => decodeURIComponent(part));
      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(join(process.cwd(), "src", "ui", "mission-control.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/missions") {
        const body = await readJson(req);
        const missionId = body.missionId ?? randomUUID();
        const state = await controller.createMission(missionId, body.userGoal ?? "");
        await publish(missionId);
        void runtime.supervisor?.wake(missionId, "mission_created");
        return json(res, 201, state);
      }
      if (parts[0] === "missions" && parts[1]) {
        const missionId = parts[1];
        if (req.method === "GET" && parts.length === 2) return json(res, 200, await controller.state(missionId));
        if (req.method === "GET" && parts[2] === "summary" && parts.length === 3) {
          if (!runtime.summaryReader) return json(res, 503, { error: "operational_summary_reader_unavailable" });
          const summary = runtime.summaryReader.readSummary(missionId);
          return summary ? json(res, 200, summary) : json(res, 404, { error: "mission_not_found" });
        }
        if (req.method === "GET" && parts[2] === "history" && parts[3] === "export" && parts.length === 4) {
          if (!runtime.historyReader) return json(res, 503, { error: "history_reader_unavailable" });
          const afterSequence = parseOptionalInteger(url.searchParams.get("afterSequence"), 0, Number.MAX_SAFE_INTEGER);
          if (afterSequence === "invalid") return json(res, 400, { error: "invalid_after_sequence" });
          const throughSequence = parseOptionalInteger(url.searchParams.get("throughSequence"), 0, Number.MAX_SAFE_INTEGER);
          if (throughSequence === "invalid") return json(res, 400, { error: "invalid_through_sequence" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 5000);
          if (limit === "invalid") return json(res, 400, { error: "invalid_history_export_limit" });
          const page = runtime.historyReader.readExportPage(missionId, {
            ...(typeof afterSequence === "number" ? { afterSequence } : {}),
            ...(typeof throughSequence === "number" ? { throughSequence } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          });
          return page ? json(res, 200, page) : json(res, 404, { error: "mission_not_found" });
        }
        if (req.method === "GET" && parts[2] === "history" && parts[3] === "retention" && parts.length === 4) {
          if (!runtime.historyReader) return json(res, 503, { error: "history_reader_unavailable" });
          const state = runtime.historyReader.readRetentionState(missionId);
          return state ? json(res, 200, state) : json(res, 404, { error: "mission_not_found" });
        }
        if (req.method === "POST" && parts[2] === "steer") {
          const body = await readJson(req);
          const state = await controller.steer(missionId, body.message ?? "");
          await publish(missionId);
          void runtime.supervisor?.wake(missionId, "user_steering");
          return json(res, 200, state);
        }
        if (req.method === "POST" && parts[2] === "wake" && parts.length === 3) {
          if (!runtime.supervisor) return json(res, 503, { error: "mission_supervisor_unavailable" });
          void runtime.supervisor.wake(missionId, "manual");
          return json(res, 202, await controller.state(missionId));
        }
        if (req.method === "GET" && parts[2] === "approvals" && parts.length === 3) {
          if (!runtime.approvalReader) return json(res, 503, { error: "approval_reader_unavailable" });
          const statusValue = parseOptionalToken(url.searchParams.get("status"));
          if (statusValue === "invalid" || (statusValue && !APPROVAL_STATUSES.has(statusValue as "pending" | "approved" | "rejected"))) {
            return json(res, 400, { error: "invalid_approval_status" });
          }
          const afterId = parseOptionalIdentifier(url.searchParams.get("afterId"));
          if (afterId === "invalid") return json(res, 400, { error: "invalid_after_id" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_approval_limit" });
          return json(res, 200, runtime.approvalReader.readApprovals(missionId, {
            ...(typeof statusValue === "string" ? { status: statusValue as "pending" | "approved" | "rejected" } : {}),
            ...(typeof afterId === "string" ? { afterId } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (req.method === "POST" && parts[2] === "approvals" && parts[3] && parts.length === 4) {
          if (!runtime.approvals) return json(res, 503, { error: "approval_manager_unavailable" });
          const body = await readJson(req);
          if (typeof body.approved !== "boolean") return json(res, 400, { error: "approved_must_be_boolean" });
          if (body.scope !== undefined && body.scope !== "once") {
            return json(res, 400, { error: "only_once_approval_scope_is_supported" });
          }
          const record = await runtime.approvals.decide(missionId, parts[3], {
            approved: body.approved,
            scope: "once",
            ...(typeof body.actor === "string" && body.actor ? { actor: body.actor } : {}),
            ...(typeof body.reason === "string" && body.reason ? { reason: body.reason } : {})
          });
          await publish(missionId);
          void runtime.supervisor?.wake(missionId, "approval_event");
          return json(res, 200, record);
        }
        if (req.method === "GET" && parts[2] === "findings" && parts.length === 3) {
          if (!runtime.findingReader) return json(res, 503, { error: "finding_reader_unavailable" });
          const afterId = parseOptionalIdentifier(url.searchParams.get("afterId"));
          if (afterId === "invalid") return json(res, 400, { error: "invalid_after_id" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_finding_limit" });
          return json(res, 200, runtime.findingReader.readFindings(missionId, {
            ...(typeof afterId === "string" ? { afterId } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (req.method === "GET" && parts[2] === "evidence" && (parts.length === 3 || (parts[3] === "page" && parts.length === 4))) {
          if (!runtime.evidenceReader) return json(res, 503, { error: "evidence_reader_unavailable" });
          const subjectRef = parseOptionalIdentifier(url.searchParams.get("subjectRef"));
          if (subjectRef === "invalid") return json(res, 400, { error: "invalid_evidence_subject_ref" });
          const collectorId = parseOptionalIdentifier(url.searchParams.get("collectorId"));
          if (collectorId === "invalid") return json(res, 400, { error: "invalid_evidence_collector_id" });
          const kindValue = parseOptionalToken(url.searchParams.get("kind"));
          if (kindValue === "invalid" || (kindValue && !EVIDENCE_KINDS.has(kindValue as Evidence["kind"]))) {
            return json(res, 400, { error: "invalid_evidence_kind" });
          }
          const resultValue = parseOptionalToken(url.searchParams.get("result"));
          if (resultValue === "invalid" || (resultValue && !EVIDENCE_RESULTS.has(resultValue as Evidence["result"]))) {
            return json(res, 400, { error: "invalid_evidence_result" });
          }
          const afterCursor = parseOptionalInteger(url.searchParams.get("afterCursor"), 0, Number.MAX_SAFE_INTEGER);
          if (afterCursor === "invalid") return json(res, 400, { error: "invalid_evidence_cursor" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_evidence_limit" });
          const page = runtime.evidenceReader.readEvidencePage(missionId, {
            ...(typeof subjectRef === "string" ? { subjectRef } : {}),
            ...(typeof collectorId === "string" ? { collectorId } : {}),
            ...(typeof kindValue === "string" ? { kind: kindValue as Evidence["kind"] } : {}),
            ...(typeof resultValue === "string" ? { result: resultValue as Evidence["result"] } : {}),
            ...(typeof afterCursor === "number" ? { afterCursor } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          });
          return json(res, 200, parts[3] === "page" ? page : page.items);
        }
        if (req.method === "GET" && parts[2] === "side-effects" && parts.length === 3) {
          if (!runtime.sideEffectReader) return json(res, 503, { error: "side_effect_reader_unavailable" });
          const statusValue = url.searchParams.get("status")?.trim() || undefined;
          if (statusValue && !SIDE_EFFECT_STATUSES.has(statusValue as SideEffectOperationStatus)) {
            return json(res, 400, { error: "invalid_side_effect_status" });
          }
          const afterSequence = parseOptionalInteger(url.searchParams.get("afterSequence"), 0, Number.MAX_SAFE_INTEGER);
          if (afterSequence === "invalid") return json(res, 400, { error: "invalid_after_sequence" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_side_effect_limit" });
          return json(res, 200, runtime.sideEffectReader.readSideEffects(missionId, {
            operationKey: url.searchParams.get("operationKey")?.trim() || undefined,
            executionId: url.searchParams.get("executionId")?.trim() || undefined,
            workItemId: url.searchParams.get("workItemId")?.trim() || undefined,
            ...(statusValue ? { status: statusValue as SideEffectOperationStatus } : {}),
            ...(typeof afterSequence === "number" ? { afterSequence } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (req.method === "GET" && parts[2] === "activity" && parts.length === 3) {
          if (!runtime.operationalReader) return json(res, 503, { error: "operational_reader_unavailable" });
          const afterSequence = parseOptionalInteger(url.searchParams.get("afterSequence"), 0, Number.MAX_SAFE_INTEGER);
          if (afterSequence === "invalid") return json(res, 400, { error: "invalid_after_sequence" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_activity_limit" });
          const type = parseOptionalToken(url.searchParams.get("type"));
          if (type === "invalid") return json(res, 400, { error: "invalid_activity_type" });
          return json(res, 200, runtime.operationalReader.readActivity(missionId, {
            ...(typeof afterSequence === "number" ? { afterSequence } : {}),
            ...(typeof type === "string" ? { type } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (req.method === "GET" && parts[2] === "attempts" && parts.length === 3) {
          if (!runtime.operationalReader) return json(res, 503, { error: "operational_reader_unavailable" });
          const workItemId = parseOptionalIdentifier(url.searchParams.get("workItemId"));
          if (workItemId === "invalid") return json(res, 400, { error: "invalid_work_item_id" });
          const status = parseOptionalToken(url.searchParams.get("status"));
          if (status === "invalid") return json(res, 400, { error: "invalid_lifecycle_status" });
          const afterId = parseOptionalIdentifier(url.searchParams.get("afterId"));
          if (afterId === "invalid") return json(res, 400, { error: "invalid_after_id" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_attempt_limit" });
          return json(res, 200, runtime.operationalReader.readAttempts(missionId, {
            ...(typeof workItemId === "string" ? { workItemId } : {}),
            ...(typeof status === "string" ? { status } : {}),
            ...(typeof afterId === "string" ? { afterId } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (req.method === "GET" && parts[2] === "executions" && parts.length === 3) {
          if (!runtime.operationalReader) return json(res, 503, { error: "operational_reader_unavailable" });
          const workItemId = parseOptionalIdentifier(url.searchParams.get("workItemId"));
          if (workItemId === "invalid") return json(res, 400, { error: "invalid_work_item_id" });
          const attemptId = parseOptionalIdentifier(url.searchParams.get("attemptId"));
          if (attemptId === "invalid") return json(res, 400, { error: "invalid_attempt_id" });
          const status = parseOptionalToken(url.searchParams.get("status"));
          if (status === "invalid") return json(res, 400, { error: "invalid_lifecycle_status" });
          const afterId = parseOptionalIdentifier(url.searchParams.get("afterId"));
          if (afterId === "invalid") return json(res, 400, { error: "invalid_after_id" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_execution_limit" });
          return json(res, 200, runtime.operationalReader.readExecutions(missionId, {
            ...(typeof workItemId === "string" ? { workItemId } : {}),
            ...(typeof attemptId === "string" ? { attemptId } : {}),
            ...(typeof status === "string" ? { status } : {}),
            ...(typeof afterId === "string" ? { afterId } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          }));
        }
        if (
          req.method === "GET" &&
          parts[2] === "capabilities" &&
          parts[3] === "ledger" &&
          parts.length === 4
        ) {
          if (!runtime.capabilityLedgerReader) {
            return json(res, 503, { error: "capability_ledger_reader_unavailable" });
          }
          const capabilityId = parseOptionalIdentifier(url.searchParams.get("capabilityId"));
          if (capabilityId === "invalid") return json(res, 400, { error: "invalid_capability_id" });
          const limit = parseOptionalInteger(url.searchParams.get("limit"), 1, 500);
          if (limit === "invalid") return json(res, 400, { error: "invalid_capability_ledger_limit" });
          const trustAfter = parseOptionalInteger(url.searchParams.get("trustAfter"), 0, Number.MAX_SAFE_INTEGER);
          if (trustAfter === "invalid") return json(res, 400, { error: "invalid_capability_trust_cursor" });
          const costsAfter = parseOptionalInteger(url.searchParams.get("costsAfter"), 0, Number.MAX_SAFE_INTEGER);
          if (costsAfter === "invalid") return json(res, 400, { error: "invalid_capability_cost_cursor" });
          const auditAfter = parseOptionalInteger(url.searchParams.get("auditAfter"), 0, Number.MAX_SAFE_INTEGER);
          if (auditAfter === "invalid") return json(res, 400, { error: "invalid_capability_audit_cursor" });
          const phaseValue = parseOptionalToken(url.searchParams.get("phase"));
          if (phaseValue === "invalid" || (phaseValue && !CAPABILITY_COST_PHASES.has(phaseValue as CapabilityCostRecord["phase"]))) {
            return json(res, 400, { error: "invalid_capability_cost_phase" });
          }
          const decisionValue = parseOptionalToken(url.searchParams.get("decision"));
          if (decisionValue === "invalid" || (decisionValue && !CAPABILITY_AUDIT_DECISIONS.has(decisionValue as CapabilityAuditDecision))) {
            return json(res, 400, { error: "invalid_capability_audit_decision" });
          }
          const common = {
            ...(typeof capabilityId === "string" ? { capabilityId } : {}),
            ...(typeof limit === "number" ? { limit } : {})
          };
          const trust = runtime.capabilityLedgerReader.readCapabilityTrustPage(missionId, {
            ...common,
            ...(typeof trustAfter === "number" ? { afterCursor: trustAfter } : {})
          });
          const costs = runtime.capabilityLedgerReader.readCapabilityCostsPage(missionId, {
            ...common,
            ...(typeof costsAfter === "number" ? { afterCursor: costsAfter } : {}),
            ...(typeof phaseValue === "string" ? { phase: phaseValue as CapabilityCostRecord["phase"] } : {})
          });
          const audit = runtime.capabilityLedgerReader.readCapabilityAuditPage(missionId, {
            ...common,
            ...(typeof auditAfter === "number" ? { afterCursor: auditAfter } : {}),
            ...(typeof decisionValue === "string" ? { decision: decisionValue as CapabilityAuditDecision } : {})
          });
          return json(res, 200, {
            trust: trust.items,
            costs: costs.items,
            audit: audit.items,
            next: {
              ...(trust.nextCursor !== undefined ? { trust: trust.nextCursor } : {}),
              ...(costs.nextCursor !== undefined ? { costs: costs.nextCursor } : {}),
              ...(audit.nextCursor !== undefined ? { audit: audit.nextCursor } : {})
            }
          });
        }
        if (
          req.method === "POST" &&
          parts[2] === "capabilities" &&
          parts[3] === "cache" &&
          parts[4] &&
          parts[5] === "revoke" &&
          parts.length === 6
        ) {
          if (!runtime.capabilityLifecycle) {
            return json(res, 503, { error: "capability_lifecycle_manager_unavailable" });
          }
          const body = await readJson(req);
          if (typeof body.reason !== "string" || !body.reason.trim()) {
            return json(res, 400, { error: "capability_cache_revocation_reason_required" });
          }
          const cacheKey = parts[4];
          if (!/^[0-9a-f]{64}$/.test(cacheKey)) {
            return json(res, 400, { error: "invalid_capability_cache_key" });
          }
          await runtime.capabilityLifecycle.revokeTrustedCache({
            missionId,
            cacheKey,
            reason: body.reason.trim()
          });
          return json(res, 200, {
            cacheKey,
            status: "revoked"
          });
        }
        if (
          req.method === "POST" &&
          parts[2] === "capabilities" &&
          parts[3] &&
          (parts[4] === "deactivate" || parts[4] === "revoke") &&
          parts.length === 5
        ) {
          if (!runtime.capabilityLifecycle) {
            return json(res, 503, { error: "capability_lifecycle_manager_unavailable" });
          }
          const body = await readJson(req);
          if (typeof body.reason !== "string" || !body.reason.trim()) {
            return json(res, 400, { error: "capability_lifecycle_reason_required" });
          }
          const capabilityId = parts[3];
          const revoked = parts[4] === "revoke";
          await runtime.capabilityLifecycle.deactivate({
            missionId,
            capabilityId,
            reason: body.reason.trim(),
            revoked
          });
          await publish(missionId);
          void runtime.supervisor?.wake(missionId, "manual");
          return json(res, 200, {
            capabilityId,
            status: revoked ? "revoked" : "deactivated",
            state: await controller.state(missionId)
          });
        }
        if (req.method === "GET" && parts[2] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const set = subscribers.get(missionId) ?? new Set<ServerResponse>();
          set.add(res); subscribers.set(missionId, set);
          res.write(`event: mission.updated\ndata: ${JSON.stringify(await controller.state(missionId))}\n\n`);
          releaseRequest(res);
          req.on("close", () => {
            set.delete(res);
            if (set.size === 0) subscribers.delete(missionId);
          });
          return;
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  const missionServer = server as MissionApiServer;
  missionServer.beginDrain = () => {
    if (draining) return;
    draining = true;
    for (const responses of subscribers.values()) {
      for (const res of responses) {
        if (!res.writableEnded) {
          res.write("event: runtime.shutdown\ndata: {}\n\n");
          res.end();
        }
      }
    }
    subscribers.clear();
  };
  missionServer.waitForRequestDrain = async () => {
    if (activeRequests.size === 0) return;
    await new Promise<void>(resolve => requestDrainWaiters.add(resolve));
  };
  missionServer.isDraining = () => draining;

  server.on("close", () => unsubscribeSupervisor?.());
  return missionServer;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

function parseOptionalInteger(raw: string | null, minimum: number, maximum: number): number | undefined | "invalid" {
  if (raw === null || raw.trim() === "") return undefined;
  if (!/^\d+$/.test(raw)) return "invalid";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) return "invalid";
  return value;
}

function parseOptionalIdentifier(raw: string | null): string | undefined | "invalid" {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (value.length > 256) return "invalid";
  return value;
}

function parseOptionalToken(raw: string | null): string | undefined | "invalid" {
  if (raw === null || raw.trim() === "") return undefined;
  const value = raw.trim();
  if (value.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value)) return "invalid";
  return value;
}

async function readJson(req: AsyncIterable<any>) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
