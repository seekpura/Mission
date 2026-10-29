import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
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
import { RuntimeShutdownTimeoutError } from "../../src/runtime/runtime-shutdown.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

class AdmissionRaceHost implements HostAdapter {
  readonly createEntered = deferred<void>();
  readonly createResult = deferred<HostAgentHandle>();
  readonly cancelled = deferred<void>();
  cancelCalls = 0;

  async describeHost(): Promise<HostDescriptor> {
    return { type: "admission-race-host", version: "1" };
  }

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
    this.createEntered.resolve();
    return this.createResult.promise;
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
    yield { type: "failed", payload: { error: "cancelled during drain" }, at: new Date().toISOString() };
  }

  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }

  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

test("Host drain does not report idle while createAgent admission is still in flight", async () => {
  const base = new AdmissionRaceHost();
  const host = new DrainableHostAdapter(base);
  const creation = host.createAgent({
    missionId: "mission-admission-race",
    workItemId: "work-admission-race",
    context: {},
    allowedCapabilityRefs: []
  });

  await base.createEntered.promise;
  assert.equal(host.snapshot().admissionsInFlight, 1);
  host.beginDrain();

  let idleResolved = false;
  const idle = host.waitForIdle().then(() => { idleResolved = true; });
  await Promise.resolve();
  assert.equal(idleResolved, false, "an unresolved provider admission must keep the Host drain barrier busy");

  const lateHandle = { id: "late-handle", nativeRef: "late-native" };
  base.createResult.resolve(lateHandle);
  const handle = await creation;
  assert.deepEqual(handle, lateHandle);
  assert.equal(host.snapshot().admissionsInFlight, 0);
  assert.deepEqual(host.snapshot().activeHandleIds, [lateHandle.id]);

  const observed = (async () => {
    const events: HostAgentEvent[] = [];
    for await (const event of host.observeAgent(handle)) events.push(event);
    return events;
  })();

  await idle;
  const events = await observed;
  assert.equal(base.cancelCalls, 1, "a handle admitted after drain begins must be cancelled exactly once");
  assert.equal(events.at(-1)?.type, "failed");
  assert.equal(host.activeCount(), 0);
});

test("Shutdown timeout with an unresolved host admission leaves SQLite open for durable recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-shutdown-admission-timeout-"));
  const dbPath = join(root, "mission.db");
  const schemaPath = join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
  const base = new AdmissionRaceHost();
  const runtime = createMissionRuntime({
    rootDir: root,
    dbPath,
    schemaPath,
    host: base,
    executorId: "admission-race-host",
    maxSupervisorCycles: 8
  });
  let cleaned = false;

  try {
    await runtime.controller.createMission("mission-admission-timeout", "prove shutdown keeps durable state recoverable");
    void runtime.supervisor.wake("mission-admission-timeout", "manual");
    await base.createEntered.promise;

    await assert.rejects(
      () => runtime.shutdown({ gracefulTimeoutMs: 5, forcedTimeoutMs: 10 }),
      (error: unknown) => {
        assert(error instanceof RuntimeShutdownTimeoutError);
        assert.equal(error.hostAdmissionsInFlight, 1);
        assert.deepEqual(error.activeHostHandleIds, []);
        return true;
      }
    );

    // A timed-out shutdown deliberately leaves the database open rather than
    // closing it under a provider operation that may still complete and write.
    const stillReadable = await runtime.controller.state("mission-admission-timeout");
    assert.equal(stillReadable.missionId, "mission-admission-timeout");

    base.createResult.resolve({ id: "late-runtime-handle", nativeRef: "late-runtime-native" });
    await runtime.supervisor.waitForAllIdle();
    const settled = await runtime.shutdown({ gracefulTimeoutMs: 100, forcedTimeoutMs: 1_000 });
    assert.equal(settled.forced, false);
    assert.equal(base.cancelCalls, 1);
    cleaned = true;

    const reopened = createMissionRuntime({
      rootDir: root,
      dbPath,
      schemaPath,
      host: new AdmissionRaceHost(),
      executorId: "admission-race-host"
    });
    try {
      const recovered = await reopened.controller.state("mission-admission-timeout");
      assert.equal(recovered.missionId, "mission-admission-timeout");
      assert.notEqual(recovered.status, "completed");
    } finally {
      reopened.close();
    }
  } finally {
    if (!cleaned) {
      base.createResult.resolve({ id: "cleanup-handle", nativeRef: "cleanup-native" });
      try {
        await runtime.supervisor.waitForAllIdle();
        await runtime.shutdown({ gracefulTimeoutMs: 100, forcedTimeoutMs: 1_000 });
      } catch {
        // Preserve the original assertion failure; the temp directory cleanup below is best-effort.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
