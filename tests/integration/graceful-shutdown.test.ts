import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import type { MissionController } from "../../src/core/mission/controller.ts";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "../../src/hosts/host-adapter.ts";
import { createMissionRuntime } from "../../src/runtime/bootstrap.ts";
import { DrainableHostAdapter } from "../../src/runtime/drainable-host-adapter.ts";
import { MissionSupervisor } from "../../src/runtime/mission-supervisor.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";
import { shutdownHttpRuntime } from "../../src/server/graceful-shutdown.ts";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

function missionState(missionId: string): MissionState {
  return {
    missionId,
    status: "executing",
    revision: 1,
    graphRevision: 1,
    requirementRefs: [],
    constraintRefs: [],
    truthRefs: [],
    openGapRefs: [],
    pendingApprovalIds: [],
    finalArtifactRefs: [],
    activeWorkItemRefs: [],
    completedWorkItemRefs: [],
    failedWorkItemRefs: [],
    cancelledWorkItemRefs: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  } as unknown as MissionState;
}

class BlockingHost implements HostAdapter {
  readonly started = deferred<void>();
  private readonly cancelled = deferred<void>();
  cancelCalls = 0;
  createCalls = 0;

  async describeHost(): Promise<HostDescriptor> { return { type: "blocking-host", version: "1" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(_request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.createCalls += 1;
    this.started.resolve();
    return { id: `blocking-${this.createCalls}`, nativeRef: `native-${this.createCalls}` };
  }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {
    this.cancelCalls += 1;
    this.cancelled.resolve();
  }
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    await this.cancelled.promise;
    yield { type: "failed", payload: { error: "cancelled for shutdown" }, at: new Date().toISOString() };
  }
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

test("MissionSupervisor drain lets the current cycle reach its boundary but suppresses queued/reentrant wakes", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let cycles = 0;
  let sequence = 0;
  const controller = {
    async state(missionId: string) { return missionState(missionId); },
    async runControllerCycle() {
      cycles += 1;
      entered.resolve();
      await release.promise;
      sequence += 1;
    }
  } as unknown as MissionController;
  const events = {
    async lastSequence() { return sequence; }
  } as unknown as EventStore;
  const supervisor = new MissionSupervisor(controller, events, { maxCyclesPerWake: 8 });

  const first = supervisor.wake("mission-drain", "manual");
  await entered.promise;
  supervisor.beginDrain();
  const ignored = supervisor.wake("mission-drain", "execution_event");
  release.resolve();

  await Promise.all([first, ignored, supervisor.waitForAllIdle()]);
  assert.equal(cycles, 1);
  assert.equal(supervisor.isDraining(), true);
  assert.deepEqual(supervisor.activeMissionIds(), []);
});

test("DrainableHostAdapter blocks new sessions, cancels tracked sessions and resolves idle only after observation settles", async () => {
  const base = new BlockingHost();
  const host = new DrainableHostAdapter(base);
  const handle = await host.createAgent({
    missionId: "mission-host-drain",
    workItemId: "work-1",
    context: {},
    allowedCapabilityRefs: []
  });
  const observed = (async () => {
    const events: HostAgentEvent[] = [];
    for await (const event of host.observeAgent(handle)) events.push(event);
    return events;
  })();

  assert.equal(host.activeCount(), 1);
  host.beginDrain();
  await assert.rejects(
    () => host.createAgent({ missionId: "m", workItemId: "w", context: {}, allowedCapabilityRefs: [] }),
    /draining/
  );
  assert.deepEqual(await host.invokeHostCapability({ capabilityId: "anything", input: {} }), {
    ok: false,
    error: "Mission Runtime host is draining"
  });

  const cancellation = await host.cancelActive();
  assert.deepEqual(cancellation.attempted, [handle.id]);
  assert.deepEqual(cancellation.failures, []);
  await host.waitForIdle();
  const events = await observed;
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(host.activeCount(), 0);
});

test("Mission API drain returns 503 to new requests and closes passive SSE subscribers", async () => {
  const controller = {
    async state(missionId: string) { return missionState(missionId); }
  } as unknown as MissionController;
  const events = {} as EventStore;
  const server = createMissionApi(controller, events);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const streamResponse = await fetch(`${base}/missions/mission-sse/events`);
    assert.equal(streamResponse.status, 200);
    server.beginDrain();
    const streamText = await streamResponse.text();
    assert.match(streamText, /event: runtime\.shutdown/);

    const blocked = await fetch(`${base}/missions/mission-sse`);
    assert.equal(blocked.status, 503);
    assert.deepEqual(await blocked.json(), { error: "runtime_draining" });
    await server.waitForRequestDrain();
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("HTTP shutdown waits for an admitted request before calling runtime shutdown", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  const controller = {
    async state(missionId: string) {
      entered.resolve();
      await release.promise;
      return missionState(missionId);
    }
  } as unknown as MissionController;
  const server = createMissionApi(controller, {} as EventStore);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  let shutdownCalls = 0;
  const runtime = {
    async shutdown() {
      shutdownCalls += 1;
      return { forced: false, cancelledHandleIds: [], cancellationFailures: [] };
    }
  };

  const request = fetch(`${base}/missions/mission-http-drain`);
  await entered.promise;
  const shutdown = shutdownHttpRuntime(server, runtime, { gracefulTimeoutMs: 100, forcedTimeoutMs: 100 });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(shutdownCalls, 0, "runtime shutdown must wait for admitted HTTP handlers");
  release.resolve();

  const response = await request;
  assert.equal(response.status, 200);
  await shutdown;
  assert.equal(shutdownCalls, 1);
});

test("Runtime forced shutdown cancels a blocked host session, settles the supervisor and leaves the durable DB reopenable", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-shutdown-runtime-"));
  const dbPath = join(root, "mission.db");
  const schemaPath = join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
  const host = new BlockingHost();
  const runtime = createMissionRuntime({ rootDir: root, dbPath, schemaPath, host, executorId: "blocking-host" });

  try {
    await runtime.controller.createMission("mission-forced-shutdown", "prove durable shutdown recovery");
    void runtime.supervisor.wake("mission-forced-shutdown", "manual");
    await host.started.promise;

    const result = await runtime.shutdown({ gracefulTimeoutMs: 10, forcedTimeoutMs: 1_000 });
    assert.equal(result.forced, true);
    assert.ok(result.cancelledHandleIds.length >= 1);
    assert.ok(host.cancelCalls >= 1);
    assert.deepEqual(runtime.supervisor.activeMissionIds(), []);

    const reopened = createMissionRuntime({
      rootDir: root,
      dbPath,
      schemaPath,
      host: new BlockingHost(),
      executorId: "blocking-host"
    });
    try {
      const state = await reopened.controller.state("mission-forced-shutdown");
      assert.equal(state.missionId, "mission-forced-shutdown");
      assert.notEqual(state.status, "completed");
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("synchronous close fails closed while async shutdown is already draining", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-shutdown-close-race-"));
  const dbPath = join(root, "mission.db");
  const schemaPath = join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
  const host = new BlockingHost();
  const runtime = createMissionRuntime({ rootDir: root, dbPath, schemaPath, host, executorId: "blocking-host" });

  try {
    await runtime.controller.createMission("mission-close-race", "guard sync close during async shutdown");
    void runtime.supervisor.wake("mission-close-race", "manual");
    await host.started.promise;

    const shutdown = runtime.shutdown({ gracefulTimeoutMs: 20, forcedTimeoutMs: 1_000 });
    assert.throws(
      () => runtime.close(),
      /Cannot synchronously close Mission Runtime while asynchronous shutdown is in progress/,
      "sync close must not race the async shutdown coordinator or close SQLite early"
    );
    await shutdown;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
