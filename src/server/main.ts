import { MissionRuntime } from "../runtime/mission-runtime.ts";
import { createMissionApi } from "./mission-api.ts";

const runtime = new MissionRuntime();
const port = Number(process.env.PORT ?? 8787);
const server = createMissionApi(runtime.controller, runtime.events, { projections: runtime.projections, orchestrator: runtime.orchestrator, steer: (missionId, message) => runtime.steer(missionId, message) });
server.listen(port, "127.0.0.1", () => console.log(`Mission Runtime listening on http://127.0.0.1:${port}`));

const close = () => {
  server.close(() => runtime.close());
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
