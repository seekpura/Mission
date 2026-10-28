import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  SideEffectAdmission,
  SideEffectClass,
  SideEffectCompletion,
  SideEffectIntent,
  SideEffectPolicy,
  SideEffectRecord
} from "../core/domain/execution.ts";
import type { MissionEvent, MissionEventType } from "../core/domain/event.ts";
import type { EventStore } from "../core/events/event-store.ts";
import type { ApprovalRequest, ApprovalResult, HostAgentEvent } from "../hosts/host-adapter.ts";

export interface SideEffectApprovalRequest {
  missionId: string;
  intent: SideEffectIntent;
  reason: string;
}

export interface SideEffectApprovalBroker {
  requestHostApproval(request: ApprovalRequest): Promise<ApprovalResult>;
  requestSideEffectApproval(request: SideEffectApprovalRequest): Promise<{ approved: boolean; actor?: string }>;
}

export interface SideEffectAuthorizationResult {
  intent: SideEffectIntent;
  admission: SideEffectAdmission;
}

export interface HostSideEffectObservationInput {
  missionId: string;
  workItemId: string;
  attemptId: string;
  executionId: string;
  workspaceRoot?: string;
  events: HostAgentEvent[];
}

export interface HostSideEffectObservationResult {
  sideEffects: SideEffectRecord[];
  violations: string[];
}

export interface RuntimeSideEffectManagerOptions {
  defaultHostPolicy?: SideEffectPolicy;
}

interface HostToolCall {
  toolCallId: string;
  title: string;
  kind: string;
  rawInput?: unknown;
}

interface HostToolClassification {
  sideEffect: boolean;
  effectClass?: SideEffectClass;
  type?: SideEffectRecord["type"];
  target: string;
  reversible: boolean;
  description: string;
}

interface SideEffectHistory {
  intent?: SideEffectIntent;
  admission?: SideEffectAdmission;
  completion?: SideEffectCompletion;
  terminalType?: "completed" | "failed";
}

const DEFAULT_HOST_POLICY: SideEffectPolicy = {
  externalWrites: "approval",
  destructiveWrites: "approval",
  irreversibleActions: "approval",
  idempotencyRequired: true
};

const READ_ONLY_KINDS = new Set(["read", "view", "search", "inspect", "list", "get", "query"]);
const WRITE_KINDS = new Set(["edit", "write", "create", "update", "upload", "modify", "patch"]);
const DESTRUCTIVE_KINDS = new Set(["delete", "remove", "drop", "destroy", "erase", "truncate"]);
const IRREVERSIBLE_KINDS = new Set([
  "send", "message", "email", "publish", "post", "purchase", "payment", "charge", "deploy", "release", "submit"
]);
const EXECUTION_KINDS = new Set(["execute", "run", "shell", "terminal", "command", "exec"]);

export class RuntimeSideEffectManager {
  private readonly events: EventStore;
  private readonly approvals: SideEffectApprovalBroker;
  private readonly defaultHostPolicy: SideEffectPolicy;
  private readonly inFlight = new Map<string, Promise<SideEffectAuthorizationResult>>();

  constructor(
    events: EventStore,
    approvals: SideEffectApprovalBroker,
    options: RuntimeSideEffectManagerOptions = {}
  ) {
    this.events = events;
    this.approvals = approvals;
    this.defaultHostPolicy = clonePolicy(options.defaultHostPolicy ?? DEFAULT_HOST_POLICY);
  }

  async authorizeHostPermission(request: ApprovalRequest): Promise<ApprovalResult> {
    const toolCall = parseHostToolCall(request.details?.toolCall);
    if (!toolCall) return this.approvals.requestHostApproval(request);

    const workspaceRoot = optionalString(request.details?.workspaceRoot);
    const classification = classifyHostTool(toolCall, workspaceRoot);
    if (!classification.sideEffect || !classification.effectClass || !classification.type) {
      return this.approvals.requestHostApproval(request);
    }

    const workItemId = optionalString(request.details?.workItemId);
    const attemptId = optionalString(request.details?.attemptId);
    const executionId = optionalString(request.details?.executionId);
    const operationKey = hostOperationKey(
      request.missionId,
      workItemId,
      executionId ?? attemptId,
      toolCall.toolCallId
    );
    const intent: SideEffectIntent = {
      id: intentId(operationKey),
      missionId: request.missionId,
      ...(workItemId ? { workItemId } : {}),
      ...(attemptId ? { attemptId } : {}),
      ...(executionId ? { executionId } : {}),
      source: "host-tool",
      operationKey,
      fingerprint: fingerprintToolCall(toolCall),
      effectClass: classification.effectClass,
      type: classification.type,
      target: classification.target,
      reversible: classification.reversible,
      description: classification.description,
      createdAt: new Date().toISOString(),
      metadata: {
        toolCallId: toolCall.toolCallId,
        toolKind: toolCall.kind || "unknown"
      }
    };
    const policy = parseSideEffectPolicy(request.details?.sideEffectPolicy) ?? this.defaultHostPolicy;
    const authorization = await this.authorize(intent, policy);
    return {
      approved: authorization.admission.status === "admitted",
      scope: "once"
    };
  }

  async authorize(intent: SideEffectIntent, policy: SideEffectPolicy): Promise<SideEffectAuthorizationResult> {
    validateIntent(intent);
    const existing = this.inFlight.get(intent.operationKey);
    if (existing) return existing;
    const operation = this.authorizeOnce(intent, policy);
    this.inFlight.set(intent.operationKey, operation);
    try {
      return await operation;
    } finally {
      this.inFlight.delete(intent.operationKey);
    }
  }

  async observeHostEvents(input: HostSideEffectObservationInput): Promise<HostSideEffectObservationResult> {
    const calls = new Map<string, { call: HostToolCall; classification: HostToolClassification }>();
    const finalStatus = new Map<string, "completed" | "failed">();
    for (const event of input.events) {
      if (event.type !== "tool" || !event.payload || typeof event.payload !== "object") continue;
      const payload = event.payload as Record<string, unknown>;
      const toolCallId = optionalString(payload.toolCallId);
      if (!toolCallId) continue;
      if (optionalString(payload.sessionUpdate) === "tool_call" || payload.rawInput !== undefined || payload.kind !== undefined) {
        const call = parseHostToolCall(payload);
        if (call) calls.set(toolCallId, { call, classification: classifyHostTool(call, input.workspaceRoot) });
      }
      const status = optionalString(payload.status);
      if (status === "completed" || status === "failed") finalStatus.set(toolCallId, status);
    }

    const sideEffects: SideEffectRecord[] = [];
    const violations: string[] = [];
    for (const [toolCallId, item] of calls) {
      const classification = item.classification;
      if (!classification.sideEffect || !classification.effectClass || !classification.type) continue;
      const operationKey = hostOperationKey(input.missionId, input.workItemId, input.executionId, toolCallId);
      const history = await this.history(input.missionId, operationKey);
      const status = finalStatus.get(toolCallId);
      if (!history.admission || history.admission.status !== "admitted") {
        violations.push(
          `Host tool ${toolCallId} (${item.call.kind || "unknown"}) produced a side-effectful call without a durable admitted intent`
        );
      } else if (status === "completed" && !history.completion) {
        await this.complete(history.intent ?? this.intentFromObservation(input, item.call, classification), "succeeded", "Host reported tool call completed");
      } else if (status === "failed" && !history.completion) {
        await this.complete(history.intent ?? this.intentFromObservation(input, item.call, classification), "failed", "Host reported tool call failed");
      }

      sideEffects.push({
        type: classification.type,
        target: classification.target,
        reversible: classification.reversible,
        result: status ?? "unknown",
        intentId: history.intent?.id,
        operationKey,
        effectClass: classification.effectClass,
        status: status === "completed" ? "succeeded" : status === "failed" ? "failed" : "unknown"
      });
    }
    return { sideEffects, violations };
  }

  async complete(intent: SideEffectIntent, status: SideEffectCompletion["status"], detail?: string): Promise<SideEffectCompletion> {
    const history = await this.history(intent.missionId, intent.operationKey);
    if (history.completion) return history.completion;
    const completion: SideEffectCompletion = {
      intentId: intent.id,
      operationKey: intent.operationKey,
      status,
      ...(detail ? { detail } : {}),
      completedAt: new Date().toISOString()
    };
    await this.append(
      intent.missionId,
      status === "failed" ? "side_effect.failed" : "side_effect.completed",
      completion,
      `side-effect-terminal:${operationDigest(intent.operationKey)}`
    );
    return completion;
  }

  private async authorizeOnce(intent: SideEffectIntent, policy: SideEffectPolicy): Promise<SideEffectAuthorizationResult> {
    const before = await this.history(intent.missionId, intent.operationKey);
    if (before.intent) {
      if (before.intent.fingerprint !== intent.fingerprint) {
        return this.blockReplay(intent, "Operation key was reused with a different side-effect fingerprint");
      }
      if (before.admission?.status === "admitted" || before.completion) {
        return this.blockReplay(intent, before.completion
          ? `Side effect already has terminal status ${before.completion.status}`
          : "Side effect was already admitted and its external state is not safe to execute again");
      }
      if (before.admission?.status === "denied" || before.admission?.status === "replay_blocked") {
        return { intent: before.intent, admission: before.admission };
      }
    }

    await this.append(
      intent.missionId,
      "side_effect.intent.recorded",
      intent,
      `side-effect-intent:${operationDigest(intent.operationKey)}`
    );
    const durableIntent = (await this.history(intent.missionId, intent.operationKey)).intent ?? intent;
    if (durableIntent.fingerprint !== intent.fingerprint) {
      return this.blockReplay(intent, "Concurrent side-effect intent used the same operation key with different content");
    }

    const policyDecision = evaluatePolicy(durableIntent, policy);
    if (policyDecision === "deny") {
      return this.deny(durableIntent, "Side-effect policy denies this operation", false);
    }
    if (policyDecision === "allow") {
      return this.admit(durableIntent, "Side-effect policy allows this operation", false);
    }

    const approval = await this.approvals.requestSideEffectApproval({
      missionId: durableIntent.missionId,
      intent: durableIntent,
      reason: `Approval required for ${durableIntent.effectClass}: ${durableIntent.description}`
    });
    if (!approval.approved) {
      return this.deny(durableIntent, "User approval was rejected or unavailable", true);
    }
    return this.admit(durableIntent, "User approved the side effect for one execution", true);
  }

  private async admit(intent: SideEffectIntent, reason: string, approvalRequired: boolean): Promise<SideEffectAuthorizationResult> {
    const admission: SideEffectAdmission = {
      intentId: intent.id,
      operationKey: intent.operationKey,
      status: "admitted",
      reason,
      approvalRequired,
      decidedAt: new Date().toISOString()
    };
    await this.append(
      intent.missionId,
      "side_effect.admitted",
      admission,
      `side-effect-admission:${operationDigest(intent.operationKey)}`
    );
    return { intent, admission };
  }

  private async deny(intent: SideEffectIntent, reason: string, approvalRequired: boolean): Promise<SideEffectAuthorizationResult> {
    const admission: SideEffectAdmission = {
      intentId: intent.id,
      operationKey: intent.operationKey,
      status: "denied",
      reason,
      approvalRequired,
      decidedAt: new Date().toISOString()
    };
    await this.append(
      intent.missionId,
      "side_effect.denied",
      admission,
      `side-effect-admission:${operationDigest(intent.operationKey)}`
    );
    return { intent, admission };
  }

  private async blockReplay(intent: SideEffectIntent, reason: string): Promise<SideEffectAuthorizationResult> {
    const durable = (await this.history(intent.missionId, intent.operationKey)).intent ?? intent;
    const admission: SideEffectAdmission = {
      intentId: durable.id,
      operationKey: durable.operationKey,
      status: "replay_blocked",
      reason,
      approvalRequired: false,
      decidedAt: new Date().toISOString()
    };
    await this.append(
      durable.missionId,
      "side_effect.replay_blocked",
      admission,
      `side-effect-replay:${operationDigest(durable.operationKey)}`
    );
    return { intent: durable, admission };
  }

  private async history(missionId: string, operationKey: string): Promise<SideEffectHistory> {
    const history: SideEffectHistory = {};
    for (const event of await this.events.list(missionId)) {
      if (!event.type.startsWith("side_effect.")) continue;
      const payload = event.payload as { operationKey?: string };
      if (payload.operationKey !== operationKey) continue;
      if (event.type === "side_effect.intent.recorded") history.intent = event.payload as SideEffectIntent;
      if (event.type === "side_effect.admitted" || event.type === "side_effect.denied" || event.type === "side_effect.replay_blocked") {
        history.admission = event.payload as SideEffectAdmission;
      }
      if (event.type === "side_effect.completed") {
        history.completion = event.payload as SideEffectCompletion;
        history.terminalType = "completed";
      }
      if (event.type === "side_effect.failed") {
        history.completion = event.payload as SideEffectCompletion;
        history.terminalType = "failed";
      }
    }
    return history;
  }

  private intentFromObservation(
    input: HostSideEffectObservationInput,
    call: HostToolCall,
    classification: HostToolClassification
  ): SideEffectIntent {
    const operationKey = hostOperationKey(input.missionId, input.workItemId, input.executionId, call.toolCallId);
    return {
      id: intentId(operationKey),
      missionId: input.missionId,
      workItemId: input.workItemId,
      attemptId: input.attemptId,
      executionId: input.executionId,
      source: "host-tool",
      operationKey,
      fingerprint: fingerprintToolCall(call),
      effectClass: classification.effectClass ?? "unknown-effect",
      type: classification.type ?? "system-change",
      target: classification.target,
      reversible: classification.reversible,
      description: classification.description,
      createdAt: new Date().toISOString(),
      metadata: { toolCallId: call.toolCallId, toolKind: call.kind || "unknown" }
    };
  }

  private async append(
    missionId: string,
    type: Extract<MissionEventType,
      | "side_effect.intent.recorded"
      | "side_effect.admitted"
      | "side_effect.denied"
      | "side_effect.completed"
      | "side_effect.failed"
      | "side_effect.replay_blocked">,
    payload: unknown,
    idempotencyKey: string
  ): Promise<MissionEvent> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const expected = await this.events.lastSequence(missionId);
      try {
        return await this.events.append({
          id: randomUUID(),
          missionId,
          type,
          actor: { type: "system", id: "runtime-side-effect-manager" },
          payload,
          idempotencyKey,
          schemaVersion: 1,
          createdAt: new Date().toISOString()
        }, expected);
      } catch (error) {
        if (attempt === 4 || !(error instanceof Error) || !error.name.includes("Concurrency")) throw error;
      }
    }
    throw new Error("Unreachable side-effect append retry state");
  }
}

export function classifyHostTool(call: HostToolCall, workspaceRoot?: string): HostToolClassification {
  const kind = call.kind.trim().toLowerCase();
  const input = objectOrEmpty(call.rawInput);
  const method = optionalString(input.method)?.toUpperCase();
  const path = firstString(input.path, input.file, input.filename, input.destination);
  const url = firstString(input.url, input.uri, input.endpoint);
  const target = sanitizeTarget(path ?? url ?? firstString(input.target, input.resource, input.repository) ?? call.title ?? kind ?? "unknown");

  if (READ_ONLY_KINDS.has(kind) && (!method || method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    return { sideEffect: false, target, reversible: true, description: `${call.title} is classified as read-only` };
  }
  if ((kind === "fetch" || kind === "request" || kind === "http") && (!method || method === "GET" || method === "HEAD" || method === "OPTIONS")) {
    return { sideEffect: false, target, reversible: true, description: `${call.title} is classified as read-only network access` };
  }
  if (WRITE_KINDS.has(kind) && path && workspaceRoot && isWithinWorkspace(workspaceRoot, path)) {
    return {
      sideEffect: false,
      effectClass: "workspace-write",
      type: "filesystem",
      target,
      reversible: true,
      description: `${call.title} writes only inside the assigned Mission workspace`
    };
  }
  if (DESTRUCTIVE_KINDS.has(kind) && path && workspaceRoot && isWithinWorkspace(workspaceRoot, path)) {
    return {
      sideEffect: false,
      effectClass: "workspace-write",
      type: "filesystem",
      target,
      reversible: false,
      description: `${call.title} mutates only the assigned Mission workspace`
    };
  }
  if (DESTRUCTIVE_KINDS.has(kind)) {
    return {
      sideEffect: true,
      effectClass: "destructive-write",
      type: path ? "filesystem" : "external-write",
      target,
      reversible: false,
      description: `${call.title} is a destructive external mutation`
    };
  }
  if (IRREVERSIBLE_KINDS.has(kind)) {
    return {
      sideEffect: true,
      effectClass: "irreversible-action",
      type: purchaseLike(kind) ? "purchase" : messageLike(kind) ? "message" : kind === "deploy" || kind === "release" ? "deployment" : "external-write",
      target,
      reversible: false,
      description: `${call.title} is an externally visible or difficult-to-reverse action`
    };
  }
  if (WRITE_KINDS.has(kind) || method === "POST" || method === "PUT" || method === "PATCH") {
    return {
      sideEffect: true,
      effectClass: "external-write",
      type: url ? "network" : path ? "filesystem" : "external-write",
      target,
      reversible: true,
      description: `${call.title} writes outside the assigned Mission workspace`
    };
  }
  if (method === "DELETE") {
    return {
      sideEffect: true,
      effectClass: "destructive-write",
      type: "network",
      target,
      reversible: false,
      description: `${call.title} performs a destructive network mutation`
    };
  }
  if (EXECUTION_KINDS.has(kind)) {
    return {
      sideEffect: true,
      effectClass: "unknown-effect",
      type: "system-change",
      target,
      reversible: false,
      description: `${call.title} executes an operation whose external side effects cannot be proven absent before execution`
    };
  }
  return {
    sideEffect: true,
    effectClass: "unknown-effect",
    type: "system-change",
    target,
    reversible: false,
    description: `${call.title} requested permission but its side-effect semantics are unknown; Runtime fails closed`
  };
}

export function evaluatePolicy(intent: SideEffectIntent, policy: SideEffectPolicy): "allow" | "approval" | "deny" {
  if (policy.idempotencyRequired && !intent.operationKey.trim()) return "deny";
  switch (intent.effectClass) {
    case "workspace-write":
      return "allow";
    case "external-write":
      return policy.externalWrites;
    case "destructive-write":
      if (policy.externalWrites === "deny" || policy.destructiveWrites === "deny") return "deny";
      return "approval";
    case "irreversible-action":
    case "unknown-effect":
      if (policy.externalWrites === "deny" || policy.irreversibleActions === "deny") return "deny";
      return "approval";
  }
}

function parseHostToolCall(value: unknown): HostToolCall | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  const toolCallId = optionalString(object.toolCallId);
  if (!toolCallId) return undefined;
  return {
    toolCallId,
    title: optionalString(object.title) ?? `Host tool ${toolCallId}`,
    kind: optionalString(object.kind) ?? "unknown",
    ...(object.rawInput !== undefined ? { rawInput: object.rawInput } : {})
  };
}

function parseSideEffectPolicy(value: unknown): SideEffectPolicy | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const object = value as Record<string, unknown>;
  if (!["deny", "approval", "allow"].includes(String(object.externalWrites))) return undefined;
  if (!["deny", "approval"].includes(String(object.destructiveWrites))) return undefined;
  if (!["deny", "approval"].includes(String(object.irreversibleActions))) return undefined;
  if (typeof object.idempotencyRequired !== "boolean") return undefined;
  return {
    externalWrites: object.externalWrites as SideEffectPolicy["externalWrites"],
    destructiveWrites: object.destructiveWrites as SideEffectPolicy["destructiveWrites"],
    irreversibleActions: object.irreversibleActions as SideEffectPolicy["irreversibleActions"],
    idempotencyRequired: object.idempotencyRequired
  };
}

function validateIntent(intent: SideEffectIntent): void {
  if (!intent.id.trim()) throw new Error("SideEffectIntent requires id");
  if (!intent.missionId.trim()) throw new Error("SideEffectIntent requires missionId");
  if (!intent.operationKey.trim()) throw new Error("SideEffectIntent requires a stable operationKey");
  if (!intent.fingerprint.trim()) throw new Error("SideEffectIntent requires fingerprint");
  if (!intent.target.trim()) throw new Error("SideEffectIntent requires target");
}

function hostOperationKey(
  missionId: string,
  workItemId: string | undefined,
  executionScope: string | undefined,
  toolCallId: string
): string {
  return `host-tool:${missionId}:${workItemId ?? "unscoped"}:${executionScope ?? "unbound"}:${toolCallId}`;
}

function intentId(operationKey: string): string {
  return `side-effect:${operationDigest(operationKey).slice(0, 32)}`;
}

function operationDigest(operationKey: string): string {
  return createHash("sha256").update(operationKey).digest("hex");
}

function fingerprintToolCall(call: HostToolCall): string {
  return createHash("sha256").update(stableJson({
    toolCallId: call.toolCallId,
    title: call.title,
    kind: call.kind,
    rawInput: call.rawInput ?? null
  })).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

function isWithinWorkspace(workspaceRoot: string, declaredPath: string): boolean {
  const root = resolve(workspaceRoot);
  const candidate = isAbsolute(declaredPath) ? resolve(declaredPath) : resolve(root, declaredPath);
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function sanitizeTarget(value: string): string {
  const trimmed = value.trim() || "unknown";
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed.slice(0, 512);
  }
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    const string = optionalString(value);
    if (string) return string;
  }
  return undefined;
}

function purchaseLike(kind: string): boolean {
  return kind === "purchase" || kind === "payment" || kind === "charge";
}

function messageLike(kind: string): boolean {
  return kind === "send" || kind === "message" || kind === "email" || kind === "publish" || kind === "post" || kind === "submit";
}

function clonePolicy(policy: SideEffectPolicy): SideEffectPolicy {
  return { ...policy };
}
