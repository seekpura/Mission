import { createProductionMissionRuntimeFromEnv } from "../runtime/bootstrap.ts";
import { createMissionApi } from "./mission-api.ts";

const runtime = createProductionMissionRuntimeFromEnv();
const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT ?? "8787"}`);
}

runtime.supervisor.onError((missionId, error) => {
  console.error(`[Mission Runtime] ${missionId}: ${error.stack ?? error.message}`);
});

const server = createMissionApi(runtime.controller, runtime.events, {
  supervisor: runtime.supervisor,
  approvals: runtime.approvals,
  capabilityLifecycle: runtime.capabilityLifecycle,
  capabilityLedgerReader: runtime.reader,
  evidenceReader: runtime.reader
});

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
