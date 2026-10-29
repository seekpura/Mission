import { createProductionMissionRuntimeFromEnv } from "../runtime/bootstrap.ts";
import { createMissionApi } from "./mission-api.ts";
import { shutdownHttpRuntime } from "./graceful-shutdown.ts";

const runtime = createProductionMissionRuntimeFromEnv();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT ?? "8787"}`);
}

const gracefulTimeoutMs = positiveShutdownTimeout(process.env.MISSION_SHUTDOWN_GRACE_MS, 30_000, "MISSION_SHUTDOWN_GRACE_MS");
const forcedTimeoutMs = positiveShutdownTimeout(process.env.MISSION_SHUTDOWN_FORCE_MS, 10_000, "MISSION_SHUTDOWN_FORCE_MS");
const hardExitTimeoutMs = positiveShutdownTimeout(
  process.env.MISSION_SHUTDOWN_HARD_EXIT_MS,
  gracefulTimeoutMs + forcedTimeoutMs + 5_000,
  "MISSION_SHUTDOWN_HARD_EXIT_MS"
);

runtime.supervisor.onError((missionId, error) => {
  console.error(`[Mission Runtime] ${missionId}: ${error.stack ?? error.message}`);
});

const server = createMissionApi(runtime.controller, runtime.events, {
  supervisor: runtime.supervisor,
  approvals: runtime.approvals,
  capabilityLifecycle: runtime.capabilityLifecycle,
  capabilityLedgerReader: runtime.reader,
  evidenceReader: runtime.reader,
  sideEffectReader: runtime.reader,
  operationalReader: runtime.reader
});

let shutdownTask: Promise<void> | undefined;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownTask) {
    console.error(`[Mission Runtime] received ${signal} while shutdown is already in progress; forcing process exit`);
    process.exit(1);
  }

  shutdownTask = (async () => {
    console.log(`[Mission Runtime] received ${signal}; stopping HTTP admission and draining active Missions`);
    const hardExitTimer = setTimeout(() => {
      console.error(`[Mission Runtime] shutdown exceeded hard deadline ${hardExitTimeoutMs}ms; forcing process exit for restart recovery`);
      process.exit(1);
    }, hardExitTimeoutMs);

    try {
      const result = await shutdownHttpRuntime(server, runtime, {
        gracefulTimeoutMs,
        forcedTimeoutMs
      });
      clearTimeout(hardExitTimer);
      if (result.forced) {
        console.warn(
          `[Mission Runtime] shutdown required cancellation of ${result.cancelledHandleIds.length} active host session(s)`
        );
      } else {
        console.log("[Mission Runtime] graceful shutdown completed");
      }
    } catch (error) {
      console.error(
        `[Mission Runtime] graceful shutdown failed; process will terminate at the hard deadline so durable recovery can resume: ` +
        `${error instanceof Error ? error.stack ?? error.message : String(error)}`
      );
      process.exitCode = 1;
    }
  })();

  await shutdownTask;
}

// Keep listeners installed during the drain so a second signal has explicit
// force-exit semantics instead of relying on platform default signal behavior.
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

server.listen(port, "127.0.0.1", () => {
  console.log(`Mission Runtime listening on http://127.0.0.1:${port}`);
  void runtime.recoverExistingMissions()
    .then(missionIds => {
      if (missionIds.length > 0) {
        console.log(`Mission Runtime resumed ${missionIds.length} non-terminal mission(s)`);
      }
    })
    .catch(error => {
      console.error(`[Mission Runtime] startup recovery failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    });
});

function positiveShutdownTimeout(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${name} must be a positive finite number`);
  return Math.floor(parsed);
}
