from pathlib import Path

path = Path("src/server/mission-api.ts")
text = path.read_text(encoding="utf-8")


def replace_once(old: str, new: str) -> None:
    global text
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"mission-api patch expected exactly one match, found {count}: {old!r}")
    text = text.replace(old, new)


replace_once(
    'import { createServer, type ServerResponse } from "node:http";\n',
    'import { createServer, type Server, type ServerResponse } from "node:http";\n',
)
replace_once(
    '''export interface MissionApiRuntime {
  supervisor?: MissionSupervisor;
''',
    '''export interface MissionApiRuntime {
  supervisor?: MissionSupervisor;
''',
)
replace_once(
    '''  evidenceReader?: Pick<SqliteMissionReader, "readEvidence">;
}

export function createMissionApi(
''',
    '''  evidenceReader?: Pick<SqliteMissionReader, "readEvidence">;
}

export interface MissionApiServer extends Server {
  beginDrain(): void;
  waitForRequestDrain(): Promise<void>;
  isDraining(): boolean;
}

export function createMissionApi(
''',
)
replace_once(
    '''  const subscribers = new Map<string, Set<ServerResponse>>();

  async function publish(missionId: string) {
''',
    '''  const subscribers = new Map<string, Set<ServerResponse>>();
  const activeRequests = new Set<ServerResponse>();
  const requestDrainWaiters = new Set<() => void>();
  let draining = false;

  function releaseRequest(res: ServerResponse): void {
    if (!activeRequests.delete(res)) return;
    if (activeRequests.size !== 0) return;
    for (const resolve of requestDrainWaiters) resolve();
    requestDrainWaiters.clear();
  }

  async function publish(missionId: string) {
''',
)
replace_once(
    '''  const server = createServer(async (req, res) => {
    try {
''',
    '''  const server = createServer(async (req, res) => {
    if (draining) return json(res, 503, { error: "runtime_draining" });
    activeRequests.add(res);
    res.once("finish", () => releaseRequest(res));
    res.once("close", () => releaseRequest(res));
    try {
''',
)
replace_once(
    '''          res.write(`event: mission.updated\\ndata: ${JSON.stringify(await controller.state(missionId))}\\n\\n`);
          req.on("close", () => {
''',
    '''          res.write(`event: mission.updated\\ndata: ${JSON.stringify(await controller.state(missionId))}\\n\\n`);
          // After the initial durable state read, SSE is a passive subscriber and
          // must not keep the request-mutation drain barrier open indefinitely.
          releaseRequest(res);
          req.on("close", () => {
''',
)
replace_once(
    '''  server.on("close", () => unsubscribeSupervisor?.());
  return server;
}
''',
    '''  const missionServer = server as MissionApiServer;
  missionServer.beginDrain = () => {
    if (draining) return;
    draining = true;
    for (const responses of subscribers.values()) {
      for (const res of responses) {
        if (!res.writableEnded) {
          res.write("event: runtime.shutdown\\ndata: {}\\n\\n");
          res.end();
        }
      }
    }
    subscribers.clear();
  };
  missionServer.waitForRequestDrain = async () => {
    if (activeRequests.size === 0) return;
    await new Promise<void>(resolve => requestDrainWaiters.add(resolve));
  };
  missionServer.isDraining = () => draining;

  server.on("close", () => unsubscribeSupervisor?.());
  return missionServer;
}
''',
)

path.write_text(text, encoding="utf-8")
