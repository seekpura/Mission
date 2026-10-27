import test from "node:test";
import assert from "node:assert/strict";
import { OfficialDeepSeekBindings } from "../../src/hosts/deepseek/official-bindings.ts";
import { DeepSeekHarnessAdapter } from "../../src/hosts/deepseek/deepseek-host-adapter.ts";

class Deferred {
  promise: Promise<void>;
  resolve!: () => void;
  constructor() { this.promise = new Promise(resolve => { this.resolve = resolve; }); }
}

test("official DSH bindings drive the public create/followup/whenIdle surface and expose host events", async () => {
  const idle = new Deferred();
  const calls: { followup?: unknown; steer?: unknown; cancel?: unknown; disposed: boolean } = { disposed: false };
  const fakeAgent = {
    id: "native-session",
    status: "running" as const,
    followup(message: unknown) { calls.followup = message; queueMicrotask(() => idle.resolve()); },
    steer(message: unknown) { calls.steer = message; },
    cancel(cause: unknown) { calls.cancel = cause; },
    whenIdle() { return idle.promise; }
  };
  const bindings = new OfficialDeepSeekBindings({
    agents: {
      async create() {
        return { agent: fakeAgent, async dispose() { calls.disposed = true; } };
      }
    }
  }, {
    version: "test",
    createUserMessage: input => ({ userMessage: input }),
    summarizeAgent: () => "{\"ok\":true}"
  });
  const host = new DeepSeekHarnessAdapter(bindings);
  const handle = await host.createAgent({ missionId: "m1", workItemId: "w1", context: "do work", allowedCapabilityRefs: [] });
  const events: string[] = [];
  let completion: unknown;
  for await (const event of host.observeAgent(handle)) {
    events.push(event.type);
    if (event.type === "completed") completion = event.payload;
  }
  assert.deepEqual(events, ["started", "completed"]);
  assert.ok(calls.followup);
  assert.equal((completion as any).text, "{\"ok\":true}");
  assert.equal(calls.disposed, true);
});
