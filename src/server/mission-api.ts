import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionController } from "../core/mission/controller.ts";
import type { EventStore } from "../core/events/event-store.ts";
import type { SqliteMissionReader } from "../persistence/sqlite/sqlite-mission-reader.ts";
import type { RuntimeApprovalManager } from "../runtime/approval-manager.ts";
import type { RuntimeCapabilityLifecycleManager } from "../runtime/capability-ledger-runtime.ts";
import type { MissionSupervisor } from "../runtime/mission-supervisor.ts";

export interface MissionApiRuntime {
  supervisor?: MissionSupervisor;
  approvals?: RuntimeApprovalManager;
  capabilityLifecycle?: RuntimeCapabilityLifecycleManager;
  capabilityLedgerReader?: Pick<
    SqliteMissionReader,
    "readCapabilityTrust" | "readCapabilityCosts" | "readCapabilityAudit"
  >;
  evidenceReader?: Pick<SqliteMissionReader, "readEvidence">;
}

export function createMissionApi(
  controller: MissionController,
  events: EventStore,
  runtime: MissionApiRuntime = {}
) {
  const subscribers = new Map<string, Set<ServerResponse>>();

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
          if (!runtime.approvals) return json(res, 503, { error: "approval_manager_unavailable" });
          return json(res, 200, await runtime.approvals.list(missionId));
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
        if (req.method === "GET" && parts[2] === "evidence" && parts.length === 3) {
          if (!runtime.evidenceReader) return json(res, 503, { error: "evidence_reader_unavailable" });
          const subjectRef = url.searchParams.get("subjectRef")?.trim() || undefined;
          return json(res, 200, runtime.evidenceReader.readEvidence(missionId, subjectRef));
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
          return json(res, 200, {
            trust: runtime.capabilityLedgerReader.readCapabilityTrust(missionId),
            costs: runtime.capabilityLedgerReader.readCapabilityCosts(missionId),
            audit: runtime.capabilityLedgerReader.readCapabilityAudit(missionId)
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
        if (req.method === "GET" && parts[2] === "activity") return json(res, 200, await events.list(missionId));
        if (req.method === "GET" && parts[2] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const set = subscribers.get(missionId) ?? new Set<ServerResponse>();
          set.add(res); subscribers.set(missionId, set);
          res.write(`event: mission.updated\ndata: ${JSON.stringify(await controller.state(missionId))}\n\n`);
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

  server.on("close", () => unsubscribeSupervisor?.());
  return server;
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: AsyncIterable<any>) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
