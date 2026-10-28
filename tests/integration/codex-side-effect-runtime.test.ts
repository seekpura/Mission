import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import { CodexAppServerHostAdapter } from "../../src/hosts/codex/codex-app-server-host-adapter.ts";
import { RuntimeSideEffectManager, type SideEffectApprovalBroker } from "../../src/runtime/side-effect-manager.ts";
import { SideEffectHostAdapter } from "../../src/runtime/side-effect-host-adapter.ts";
import { HostSideEffectScopeRegistry } from "../../src/runtime/side-effect-host-scope.ts";

class MemoryEventStore implements EventStore {
  readonly events: MissionEvent[] = [];

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const scoped = this.events.filter(item => item.missionId === event.missionId);
    if (scoped.length !== expectedSequence) throw new Error(`expected sequence ${expectedSequence}, current ${scoped.length}`);
    const committed = { ...event, sequence: expectedSequence + 1 } as MissionEvent<T>;
    this.events.push(committed as MissionEvent);
    return committed;
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    return this.events.filter(event => event.missionId === missionId && event.sequence > afterSequence);
  }

  async lastSequence(missionId: string): Promise<number> {
    return this.events.filter(event => event.missionId === missionId).length;
  }
}

class AutoApprovalBroker implements SideEffectApprovalBroker {
  hostApprovals = 0;
  sideEffectApprovals = 0;

  async requestHostApproval() {
    this.hostApprovals += 1;
    return { approved: true, scope: "once" as const };
  }

  async requestSideEffectApproval() {
    this.sideEffectApprovals += 1;
    return { approved: true, actor: "test-user" };
  }
}

const FAKE_CODEX_SIDE_EFFECT = String.raw`
const { createInterface } = require("node:readline");
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pending = null;
function send(value) { process.stdout.write(JSON.stringify(value) + "\n"); }
function reply(id, result) { send({ jsonrpc: "2.0", id, result }); }
lines.on("line", line => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === "initialize" && message.id !== undefined) {
    reply(message.id, { userAgent: "fake-codex-side-effect" });
    return;
  }
  if (message.method === "initialized") return;
  if (message.method === "thread/start" && message.id !== undefined) {
    reply(message.id, { thread: { id: "thread-side-effect" }, model: "fake", modelProvider: "fake" });
    return;
  }
  if (message.method === "turn/start" && message.id !== undefined) {
    reply(message.id, { turn: { id: "turn-side-effect", status: "inProgress" } });
    send({ jsonrpc: "2.0", method: "turn/started", params: { threadId: message.params.threadId, turn: { id: "turn-side-effect", status: "inProgress" } } });
    send({ jsonrpc: "2.0", method: "item/started", params: { threadId: message.params.threadId, turnId: "turn-side-effect", item: { id: "command-side-effect", type: "commandExecution", command: "echo durable", cwd: process.cwd(), status: "inProgress" } } });
    pending = 700;
    send({ jsonrpc: "2.0", id: pending, method: "item/commandExecution/requestApproval", params: { threadId: message.params.threadId, turnId: "turn-side-effect", itemId: "command-side-effect", command: "echo durable", cwd: process.cwd(), reason: "execute fixture command", availableDecisions: ["accept", "decline", "cancel"] } });
    return;
  }
  if (message.id === pending && message.result) {
    if (message.result.decision !== "accept") {
      send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-side-effect", turn: { id: "turn-side-effect", status: "interrupted" } } });
      return;
    }
    send({ jsonrpc: "2.0", method: "item/completed", params: { threadId: "thread-side-effect", turnId: "turn-side-effect", item: { id: "command-side-effect", type: "commandExecution", command: "echo durable", cwd: process.cwd(), status: "completed" } } });
    send({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-side-effect", turn: { id: "turn-side-effect", status: "completed" } } });
  }
});
`;

test("Codex native command approval uses Mission durable side-effect admission and settlement", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "mission-codex-side-effect-"));
  const script = join(root, "fake-codex-side-effect.cjs");
  await writeFile(script, FAKE_CODEX_SIDE_EFFECT, "utf8");
  try {
    const store = new MemoryEventStore();
    const broker = new AutoApprovalBroker();
    const sideEffects = new RuntimeSideEffectManager(store, broker);
    const scopes = new HostSideEffectScopeRegistry();
    const base = new CodexAppServerHostAdapter({
      binary: process.execPath,
      argsPrefix: [script],
      approvalHandler: request => sideEffects.authorizeHostPermission(scopes.enrich(request))
    });
    const host = new SideEffectHostAdapter(base, sideEffects, { scopeRegistry: scopes });
    const missionId = "mission-codex-side-effect";
    const handle = await host.createAgent({
      missionId,
      workItemId: "work-side-effect",
      attemptId: "attempt-side-effect",
      executionId: "execution-side-effect",
      workspaceRoot: root,
      allowedCapabilityRefs: [],
      context: "run approval fixture"
    });

    const observed = [];
    for await (const event of host.observeAgent(handle)) observed.push(event);

    assert.equal(broker.sideEffectApprovals, 1);
    assert.equal(broker.hostApprovals, 0);
    assert(observed.some(event => event.type === "completed"));
    const receipt = observed.find(event => event.type === "tool" && (event.payload as { sessionUpdate?: string }).sessionUpdate === "mission_side_effect_receipt");
    assert(receipt);
    const sideEffect = (receipt.payload as { sideEffects: Array<{ status: string; operationKey?: string }> }).sideEffects[0];
    assert.equal(sideEffect?.status, "succeeded");
    assert(sideEffect?.operationKey?.includes("execution-side-effect"));

    const durable = await store.list(missionId);
    assert(durable.some(event => event.type === "side_effect.intent.recorded"));
    assert(durable.some(event => event.type === "side_effect.admitted"));
    assert(durable.some(event => event.type === "side_effect.completed"));
    assert.equal(durable.filter(event => event.type === "side_effect.intent.recorded").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
