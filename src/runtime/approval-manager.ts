import { createHash, randomUUID } from "node:crypto";
import type { ApprovalRequest, ApprovalResult } from "../hosts/host-adapter.ts";
import type { AcquisitionApprovalBroker, AcquisitionApprovalRequest } from "../core/capabilities/acquisition-transaction.ts";
import type { EventStore } from "../core/events/event-store.ts";
import type { SideEffectApprovalRequest } from "./side-effect-manager.ts";

export type RuntimeApprovalKind = "host" | "acquisition" | "side-effect";

export type IdempotentAcquisitionApprovalRequest = AcquisitionApprovalRequest & {
  idempotencyKey?: string;
};

export interface IdempotentAcquisitionApprovalBroker {
  requestApproval(request: IdempotentAcquisitionApprovalRequest): Promise<{
    approved: boolean;
    actor?: string;
  }>;
}

export interface RuntimeApprovalRecord {
  id: string;
  missionId: string;
  kind: RuntimeApprovalKind;
  title: string;
  reason: string;
  details: Record<string, unknown>;
  status: "pending" | "approved" | "rejected";
  scope: "once" | "mission" | "revision" | "host";
  requestFingerprint?: string;
  actor?: string;
  requestedAt: string;
  decidedAt?: string;
}

interface PendingApproval {
  record: RuntimeApprovalRecord;
  decision: Promise<ApprovalResult>;
  resolve: (result: ApprovalResult) => void;
  reject: (error: unknown) => void;
  timer?: NodeJS.Timeout;
}

export interface RuntimeApprovalManagerOptions {
  timeoutMs?: number;
}

export class RuntimeApprovalManager implements AcquisitionApprovalBroker, IdempotentAcquisitionApprovalBroker {
  private readonly store: EventStore;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingApproval>();
  private disposed = false;

  constructor(store: EventStore, options: RuntimeApprovalManagerOptions = {}) {
    this.store = store;
    this.timeoutMs = Math.max(1_000, options.timeoutMs ?? 30 * 60_000);
  }

  async requestHostApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    return this.createAndWait({
      missionId: request.missionId,
      kind: "host",
      title: request.title,
      reason: request.reason,
      details: { ...(request.details ?? {}) },
      timeoutReason: "Approval request timed out"
    });
  }

  async requestApproval(request: IdempotentAcquisitionApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    const result = await this.createAndWait({
      missionId: request.missionId,
      kind: "acquisition",
      title: request.title,
      reason: request.reason,
      details: {
        ...request.details,
        candidateId: request.candidateId,
        capabilityNeedId: request.capabilityNeedId
      },
      timeoutReason: "Capability approval request timed out",
      ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {})
    });
    return {
      approved: result.approved,
      ...(result.approved ? { actor: "user" } : {})
    };
  }

  async requestSideEffectApproval(request: SideEffectApprovalRequest): Promise<{ approved: boolean; actor?: string }> {
    const intent = request.intent;
    const result = await this.createAndWait({
      missionId: request.missionId,
      kind: "side-effect",
      title: `Approve side effect: ${intent.description}`,
      reason: request.reason,
      details: {
        intentId: intent.id,
        operationKey: intent.operationKey,
        source: intent.source,
        effectClass: intent.effectClass,
        type: intent.type,
        target: intent.target,
        reversible: intent.reversible,
        workItemId: intent.workItemId,
        attemptId: intent.attemptId,
        executionId: intent.executionId,
        fingerprint: intent.fingerprint,
        metadata: intent.metadata
      },
      timeoutReason: "Side-effect approval request timed out"
    });
    return {
      approved: result.approved,
      ...(result.approved ? { actor: "user" } : {})
    };
  }

  async decide(
    missionId: string,
    approvalId: string,
    decision: {
      approved: boolean;
      scope?: ApprovalResult["scope"];
      actor?: string;
      reason?: string;
    }
  ): Promise<RuntimeApprovalRecord> {
    if (this.disposed) throw new Error("RuntimeApprovalManager is disposed");
    const current = (await this.list(missionId)).find(record => record.id === approvalId);
    if (!current) throw new Error(`Unknown approval request: ${approvalId}`);
    if (current.status !== "pending") return current;

    const scope = decision.scope ?? "once";
    if (scope !== "once") {
      throw new Error(`Approval scope ${scope} is not implemented; current host bridge supports one-shot approval only`);
    }
    const decidedAt = new Date().toISOString();
    await this.append(missionId, "approval.decided", {
      id: approvalId,
      approved: decision.approved,
      status: decision.approved ? "approved" : "rejected",
      scope,
      actor: decision.actor ?? "user",
      ...(decision.reason ? { reason: decision.reason } : {}),
      decidedAt
    }, `approval-decided:${approvalId}`);

    const durable = (await this.list(missionId)).find(record => record.id === approvalId);
    if (!durable || durable.status === "pending") {
      throw new Error(`Approval decision was not durably projected: ${approvalId}`);
    }

    const pending = this.pending.get(approvalId);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(approvalId);
      pending.resolve({ approved: durable.status === "approved", scope: "once" });
    }
    return durable;
  }

  async list(missionId: string): Promise<RuntimeApprovalRecord[]> {
    const records = new Map<string, RuntimeApprovalRecord>();
    for (const event of await this.store.list(missionId)) {
      if (event.type === "approval.requested") {
        const payload = event.payload as Partial<RuntimeApprovalRecord> & { id?: string };
        if (!payload.id || !payload.title || !payload.reason || !payload.kind) continue;
        records.set(payload.id, {
          id: payload.id,
          missionId,
          kind: payload.kind,
          title: payload.title,
          reason: payload.reason,
          details: { ...(payload.details ?? {}) },
          status: "pending",
          scope: payload.scope ?? "once",
          ...(typeof payload.requestFingerprint === "string"
            ? { requestFingerprint: payload.requestFingerprint }
            : {}),
          requestedAt: payload.requestedAt ?? event.createdAt
        });
      }
      if (event.type === "approval.decided") {
        const payload = event.payload as {
          id?: string;
          approved?: boolean;
          status?: "approved" | "rejected";
          scope?: RuntimeApprovalRecord["scope"];
          actor?: string;
          decidedAt?: string;
        };
        if (!payload.id) continue;
        const current = records.get(payload.id);
        if (!current) continue;
        records.set(payload.id, {
          ...current,
          status: payload.status ?? (payload.approved ? "approved" : "rejected"),
          scope: payload.scope ?? current.scope,
          ...(payload.actor ? { actor: payload.actor } : {}),
          decidedAt: payload.decidedAt ?? event.createdAt
        });
      }
    }
    return [...records.values()].sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
  }

  async listPending(missionId: string): Promise<RuntimeApprovalRecord[]> {
    return (await this.list(missionId)).filter(record => record.status === "pending");
  }

  async rejectStalePending(missionId: string): Promise<number> {
    const stale = await this.listPending(missionId);
    for (const approval of stale) {
      await this.decide(missionId, approval.id, {
        approved: false,
        scope: "once",
        actor: "system:runtime-restart",
        reason: "Runtime restarted before the approval could be delivered to the original host request"
      });
    }
    return stale.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, pending] of this.pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve({ approved: false, scope: "once" });
      this.pending.delete(id);
    }
  }

  private async createAndWait(input: {
    missionId: string;
    kind: RuntimeApprovalKind;
    title: string;
    reason: string;
    details: Record<string, unknown>;
    timeoutReason: string;
    idempotencyKey?: string;
  }): Promise<ApprovalResult> {
    if (this.disposed) return { approved: false, scope: "once" };

    const stableKey = input.idempotencyKey;
    if (stableKey !== undefined) validateIdempotencyKey(stableKey);
    const id = stableKey === undefined
      ? `approval:${randomUUID()}`
      : `approval:${input.kind}:${sha256(stableKey)}`;
    const requestFingerprint = stableKey === undefined
      ? undefined
      : `sha256:${sha256(stableJson({
          missionId: input.missionId,
          kind: input.kind,
          title: input.title,
          reason: input.reason,
          details: input.details
        }))}`;

    const active = this.pending.get(id);
    if (active) {
      assertIdempotentApprovalIdentity(active.record, requestFingerprint, id);
      return active.decision;
    }

    if (stableKey !== undefined) {
      const durable = (await this.list(input.missionId)).find(record => record.id === id);
      if (durable) {
        assertIdempotentApprovalIdentity(durable, requestFingerprint, id);
        if (durable.status !== "pending") {
          return { approved: durable.status === "approved", scope: "once" };
        }
        const liveAfterRead = this.pending.get(id);
        if (liveAfterRead) {
          assertIdempotentApprovalIdentity(liveAfterRead.record, requestFingerprint, id);
          return liveAfterRead.decision;
        }
        throw new Error(`Idempotent approval ${id} is pending without a live waiter`);
      }

      const liveAfterRead = this.pending.get(id);
      if (liveAfterRead) {
        assertIdempotentApprovalIdentity(liveAfterRead.record, requestFingerprint, id);
        return liveAfterRead.decision;
      }
    }

    const requestedAt = new Date().toISOString();
    const record: RuntimeApprovalRecord = {
      id,
      missionId: input.missionId,
      kind: input.kind,
      title: input.title,
      reason: input.reason,
      details: { ...input.details },
      status: "pending",
      scope: "once",
      ...(requestFingerprint ? { requestFingerprint } : {}),
      requestedAt
    };

    let resolveDecision!: (result: ApprovalResult) => void;
    let rejectDecision!: (error: unknown) => void;
    const decision = new Promise<ApprovalResult>((resolve, reject) => {
      resolveDecision = resolve;
      rejectDecision = reject;
    });
    void decision.catch(() => undefined);
    const pending: PendingApproval = {
      record,
      decision,
      resolve: resolveDecision,
      reject: rejectDecision
    };
    this.pending.set(id, pending);

    try {
      await this.append(input.missionId, "approval.requested", record, `approval-requested:${id}`);
    } catch (error) {
      const current = this.pending.get(id);
      if (current === pending) this.pending.delete(id);
      pending.reject(error);
      throw error;
    }

    if (this.pending.get(id) === pending && !this.disposed) {
      pending.timer = setTimeout(() => {
        void this.decide(record.missionId, record.id, {
          approved: false,
          scope: "once",
          actor: "system:approval-timeout",
          reason: input.timeoutReason
        }).catch(error => {
          if (!this.disposed) console.error(`[RuntimeApprovalManager] timeout decision failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }, this.timeoutMs);
    }
    return decision;
  }

  private async append(
    missionId: string,
    type: "approval.requested" | "approval.decided",
    payload: unknown,
    idempotencyKey: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const expected = await this.store.lastSequence(missionId);
      try {
        await this.store.append({
          id: randomUUID(),
          missionId,
          type,
          actor: { type: "system", id: "runtime-approval-manager" },
          payload,
          idempotencyKey,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        }, expected);
        return;
      } catch (error) {
        if (attempt === 3 || !(error instanceof Error) || !isConcurrencyConflict(error)) throw error;
      }
    }
  }
}

function validateIdempotencyKey(value: string): void {
  if (!value.trim()) throw new Error("Acquisition approval idempotency key must be non-empty");
  if (value.length > 4_096) throw new Error("Acquisition approval idempotency key exceeds 4096 characters");
}

function assertIdempotentApprovalIdentity(
  record: RuntimeApprovalRecord,
  requestFingerprint: string | undefined,
  id: string
): void {
  if (!requestFingerprint || record.requestFingerprint !== requestFingerprint) {
    throw new Error(`Idempotent approval request identity mismatch: ${id}`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map(item => item === undefined ? "null" : stableJson(item)).join(",")}]`;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${stableJson(nested)}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return "null";
  return encoded;
}

function isConcurrencyConflict(error: Error): boolean {
  return error.name.includes("Concurrency") || error.message.includes("expected sequence");
}