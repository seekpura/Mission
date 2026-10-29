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
import { RuntimeShutdownTimeoutError } from "../../src/runtime/runtime-shutdown.ts";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

class HangingCancelHost implements HostAdapter {
  readonly created = deferred<void>();
  readonly releaseCancel = deferred<void>();
  readonly terminal = deferred<void>();
  cancelCalls = 0;

  async describeHost(): Promise<HostDescriptor> {
    return { type: "hanging-cancel-host", version: "1" };
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
    this.created.resolve();
    return { id: "hanging-cancel-handle", nativeRef: "hanging-cancel-native" };
  }

  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not used" };
  }

  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}

  async cancelAgent(_handle: HostAgentHandle): Promise<void> {
    this.cancelCalls += 1;
    await this.releaseCancel.promise;
    this.terminal.resolve();
  }

  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    yield { type: "started", payload: {}, at: new Date().toISOString() };
    await this.terminal.promise;
    yield { type: "failed", payload: { error: "cancelled after provider release" }, at: new Date().toISOString() };
  }

  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used" };
  }

  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

test("forced shutdown deadline includes a provider cancel RPC that never returns", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-shutdown-cancel-timeout-"));
  const dbPath = join(root, "mission.db");
  const schemaPath = join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
  const host = new HangingCancelHost();
  const runtime = createMissionRuntime({
    rootDir: root,
    dbPath,
    schemaPath,
    host,
    executorId: "hanging-cancel-host",
    maxSupervisorCycles: 8
  });
  let cleaned = false;

  try {
    await runtime.controller.createMission("mission-cancel-timeout", "prove provider cancel obeys the forced shutdown deadline");
    void runtime.supervisor.wake("mission-cancel-timeout", "manual");
    await host.created.promise;

    const startedAt = Date.now();
    await assert.rejects(
      () => runtime.shutdown({ gracefulTimeoutMs: 5, forcedTimeoutMs: 15 }),
      (error: unknown) => {
        assert(error instanceof RuntimeShutdownTimeoutError);
        assert.deepEqual(error.activeHostHandleIds, ["hanging-cancel-handle"]);
        return true;
      }
    );
    assert.ok(Date.now() - startedAt < 1_000, "provider cancellation must not bypass the forced shutdown deadline");
    assert.equal(host.cancelCalls, 1);

    const stillReadable = await runtime.controller.state("mission-cancel-timeout");
    assert.equal(stillReadable.missionId, "mission-cancel-timeout");

    host.releaseCancel.resolve();
    await runtime.supervisor.waitForAllIdle();
    const settled = await runtime.shutdown({ gracefulTimeoutMs: 100, forcedTimeoutMs: 1_000 });
    assert.equal(settled.forced, false);
    assert.equal(host.cancelCalls, 1, "cleanup after observed terminal must not repeat provider cancellation");
    cleaned = true;
  } finally {
    if (!cleaned) {
      host.releaseCancel.resolve();
      try {
        await runtime.supervisor.waitForAllIdle();
        await runtime.shutdown({ gracefulTimeoutMs: 100, forcedTimeoutMs: 1_000 });
      } catch {
        // Preserve the primary assertion failure.
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
