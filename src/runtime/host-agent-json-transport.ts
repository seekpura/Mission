import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HostAdapter, HostAgentEvent, HostAgentHandle } from "../hosts/host-adapter.ts";

export const MISSION_JSON_BEGIN = "MISSION_JSON_BEGIN";
export const MISSION_JSON_END = "MISSION_JSON_END";

export interface HostJsonRequest {
  missionId: string;
  operationId: string;
  instruction: string;
  input: unknown;
  allowedCapabilityRefs?: string[];
}

export interface HostJsonTransport {
  request(input: HostJsonRequest): Promise<unknown>;
}

export interface HostAgentJsonTransportOptions {
  workspaceRoot: string;
  hardTimeoutMs?: number;
  retainWorkspaces?: boolean;
}

export class HostAgentJsonTransport implements HostJsonTransport {
  private readonly host: HostAdapter;
  private readonly workspaceRoot: string;
  private readonly hardTimeoutMs: number;
  private readonly retainWorkspaces: boolean;

  constructor(host: HostAdapter, options: HostAgentJsonTransportOptions) {
    this.host = host;
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.hardTimeoutMs = Math.max(1_000, options.hardTimeoutMs ?? 5 * 60_000);
    this.retainWorkspaces = options.retainWorkspaces ?? false;
    mkdirSync(this.workspaceRoot, { recursive: true });
  }

  async request(input: HostJsonRequest): Promise<unknown> {
    const workspace = await mkdtemp(join(this.workspaceRoot, `${safeSegment(input.missionId)}-${safeSegment(input.operationId)}-`));
    let handle: HostAgentHandle | undefined;
    try {
      handle = await this.host.createAgent({
        missionId: input.missionId,
        workItemId: `control:${input.operationId}`,
        workspaceRoot: workspace,
        allowedCapabilityRefs: [...(input.allowedCapabilityRefs ?? [])],
        context: {
          role: "Mission Runtime control-plane reasoner",
          instruction: input.instruction,
          input: input.input,
          responseProtocol: {
            rules: [
              "Do not use tools unless the instruction explicitly requires them.",
              "Return exactly one JSON value framed by the two marker lines below.",
              "Do not place prose, markdown fences, comments, or extra characters inside the frame.",
              `First marker line: ${MISSION_JSON_BEGIN}`,
              `Last marker line: ${MISSION_JSON_END}`
            ]
          }
        }
      });

      const observation = await observeText(this.host, handle, this.hardTimeoutMs);
      if (observation.terminal === "failed") {
        throw new Error(`Host control agent failed: ${observation.failure ?? "unknown failure"}`);
      }
      if (observation.timedOut) {
        throw new Error(`Host control agent timed out after ${this.hardTimeoutMs}ms`);
      }
      if (observation.terminal !== "completed") {
        throw new Error("Host control agent ended without a completed terminal event");
      }
      return parseFramedJson(observation.text);
    } finally {
      if (!this.retainWorkspaces) {
        if (handle) await safeCancelIfStillRunning(this.host, handle);
        await rm(workspace, { recursive: true, force: true });
      }
    }
  }
}

interface TextObservation {
  text: string;
  terminal: "completed" | "failed" | null;
  timedOut: boolean;
  failure?: string;
}

const TIMEOUT = Symbol("json-transport-timeout");

async function observeText(host: HostAdapter, handle: HostAgentHandle, timeoutMs: number): Promise<TextObservation> {
  const iterator = host.observeAgent(handle)[Symbol.asyncIterator]();
  const deadline = Date.now() + timeoutMs;
  const chunks: string[] = [];
  let terminal: TextObservation["terminal"] = null;
  let timedOut = false;
  let failure: string | undefined;

  try {
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        timedOut = true;
        await safeCancel(host, handle);
        break;
      }
      const next = await nextWithTimeout(iterator, remaining);
      if (next === TIMEOUT) {
        timedOut = true;
        await safeCancel(host, handle);
        break;
      }
      if (next.done) break;

      if (next.value.type === "message") chunks.push(...extractText(next.value));
      if (next.value.type === "failed") {
        terminal = "failed";
        failure = stringifyFailure(next.value.payload);
        break;
      }
      if (next.value.type === "completed") {
        terminal = "completed";
        break;
      }
    }
  } finally {
    if (timedOut) void iterator.return?.();
    else await iterator.return?.();
  }

  return { text: chunks.join(""), terminal, timedOut, ...(failure ? { failure } : {}) };
}

async function nextWithTimeout<T>(iterator: AsyncIterator<T>, timeoutMs: number): Promise<IteratorResult<T> | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<typeof TIMEOUT>(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function extractText(event: HostAgentEvent): string[] {
  const values: string[] = [];
  visitText(event.payload, values, new Set<object>());
  return values;
}

function visitText(value: unknown, output: string[], seen: Set<object>): void {
  if (typeof value === "string") return;
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) visitText(item, output, seen);
    return;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") output.push(record.text);
  for (const [key, child] of Object.entries(record)) {
    if (key === "text") continue;
    visitText(child, output, seen);
  }
}

export function parseFramedJson(text: string): unknown {
  const begin = text.lastIndexOf(MISSION_JSON_BEGIN);
  if (begin < 0) throw new Error(`Host JSON response is missing ${MISSION_JSON_BEGIN}`);
  const bodyStart = begin + MISSION_JSON_BEGIN.length;
  const end = text.indexOf(MISSION_JSON_END, bodyStart);
  if (end < 0) throw new Error(`Host JSON response is missing ${MISSION_JSON_END}`);
  const body = text.slice(bodyStart, end).trim();
  if (!body) throw new Error("Host JSON response frame is empty");
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`Host JSON response contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stringifyFailure(payload: unknown): string {
  if (payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string") {
    return (payload as { error: string }).error;
  }
  try { return JSON.stringify(payload); } catch { return String(payload); }
}

async function safeCancel(host: HostAdapter, handle: HostAgentHandle): Promise<void> {
  try { await host.cancelAgent(handle); } catch { /* preserve the primary control failure */ }
}

async function safeCancelIfStillRunning(host: HostAdapter, handle: HostAgentHandle): Promise<void> {
  try { await host.cancelAgent(handle); } catch { /* completed/unknown handles are safe to ignore during cleanup */ }
}

function safeSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return safe || "control";
}
