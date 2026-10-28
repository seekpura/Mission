import type { MissionDatabase } from "../persistence/sqlite/database.ts";
import type { RuntimeApprovalManager } from "./approval-manager.ts";
import type { DrainableHostAdapter } from "./drainable-host-adapter.ts";
import type { MissionSupervisor } from "./mission-supervisor.ts";

export interface RuntimeShutdownOptions {
  gracefulTimeoutMs?: number;
  forcedTimeoutMs?: number;
}

export interface RuntimeShutdownResult {
  forced: boolean;
  cancelledHandleIds: string[];
  cancellationFailures: Array<{ handleId: string; error: string }>;
}

export class RuntimeShutdownTimeoutError extends Error {
  readonly activeMissionIds: string[];
  readonly activeHostHandleIds: string[];

  constructor(activeMissionIds: string[], activeHostHandleIds: string[]) {
    super(
      `Mission Runtime shutdown did not settle after forced cancellation; ` +
      `active missions=${activeMissionIds.join(",") || "none"}; ` +
      `active host handles=${activeHostHandleIds.join(",") || "none"}`
    );
    this.name = "RuntimeShutdownTimeoutError";
    this.activeMissionIds = [...activeMissionIds];
    this.activeHostHandleIds = [...activeHostHandleIds];
  }
}

export async function shutdownMissionRuntime(input: {
  supervisor: MissionSupervisor;
  host: DrainableHostAdapter;
  approvals: RuntimeApprovalManager;
  database: MissionDatabase;
}, options: RuntimeShutdownOptions = {}): Promise<RuntimeShutdownResult> {
  const gracefulTimeoutMs = normalizeTimeout(options.gracefulTimeoutMs, 30_000);
  const forcedTimeoutMs = normalizeTimeout(options.forcedTimeoutMs, 10_000);

  input.supervisor.beginDrain();

  const graceful = await settleWithin(input.supervisor.waitForAllIdle(), gracefulTimeoutMs);
  if (graceful) {
    input.host.beginDrain();
    const hostIdle = await settleWithin(input.host.waitForIdle(), forcedTimeoutMs);
    if (!hostIdle) {
      const cancellation = await input.host.cancelActive();
      const settled = await settleWithin(
        Promise.all([input.supervisor.waitForAllIdle(), input.host.waitForIdle()]).then(() => undefined),
        forcedTimeoutMs
      );
      if (!settled) throw timeoutError(input);
      disposeRuntime(input.approvals, input.database);
      return {
        forced: true,
        cancelledHandleIds: cancellation.attempted,
        cancellationFailures: cancellation.failures
      };
    }

    disposeRuntime(input.approvals, input.database);
    return { forced: false, cancelledHandleIds: [], cancellationFailures: [] };
  }

  const cancellation = await input.host.cancelActive();
  const forced = await settleWithin(
    Promise.all([input.supervisor.waitForAllIdle(), input.host.waitForIdle()]).then(() => undefined),
    forcedTimeoutMs
  );
  if (!forced) throw timeoutError(input);

  disposeRuntime(input.approvals, input.database);
  return {
    forced: true,
    cancelledHandleIds: cancellation.attempted,
    cancellationFailures: cancellation.failures
  };
}

export function closeMissionRuntimeIfIdle(input: {
  supervisor: MissionSupervisor;
  host: DrainableHostAdapter;
  approvals: RuntimeApprovalManager;
  database: MissionDatabase;
}): void {
  const activeMissions = input.supervisor.activeMissionIds();
  if (activeMissions.length > 0) {
    throw new Error(`Cannot synchronously close Mission Runtime with active supervisor cycles: ${activeMissions.join(", ")}`);
  }
  const activeHandles = input.host.snapshot().activeHandleIds;
  if (activeHandles.length > 0) {
    throw new Error(`Cannot synchronously close Mission Runtime with active host sessions: ${activeHandles.join(", ")}`);
  }
  input.supervisor.beginDrain();
  input.host.closeIfIdle();
  disposeRuntime(input.approvals, input.database);
}

async function settleWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>(resolve => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function timeoutError(input: {
  supervisor: MissionSupervisor;
  host: DrainableHostAdapter;
}): RuntimeShutdownTimeoutError {
  return new RuntimeShutdownTimeoutError(
    input.supervisor.activeMissionIds(),
    input.host.snapshot().activeHandleIds
  );
}

function disposeRuntime(approvals: RuntimeApprovalManager, database: MissionDatabase): void {
  approvals.dispose();
  database.close();
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1) throw new Error(`Shutdown timeout must be a positive finite number: ${value}`);
  return Math.floor(value);
}
