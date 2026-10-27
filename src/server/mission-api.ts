import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MissionController } from "../core/mission/controller.ts";
import type { EventStore } from "../core/events/event-store.ts";

export function createMissionApi(controller: MissionController, events: EventStore) {
  const subscribers = new Map<string, Set<ServerResponse>>();

  async function publish(missionId: string) {
    const latest = await controller.state(missionId);
    for (const res of subscribers.get(missionId) ?? []) {
      res.write(`event: mission.updated\ndata: ${JSON.stringify(latest)}\n\n`);
    }
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/") {
        const html = readFileSync(join(process.cwd(), "src", "ui", "mission-control.html"), "utf8");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
      if (req.method === "POST" && url.pathname === "/missions") {
        const body = await readJson(req);
        const missionId = body.missionId ?? randomUUID();
        const state = await controller.createMission(missionId, body.userGoal ?? "");
        await publish(missionId);
        return json(res, 201, state);
      }
      if (parts[0] === "missions" && parts[1]) {
        const missionId = parts[1];
        if (req.method === "GET" && parts.length === 2) return json(res, 200, await controller.state(missionId));
        if (req.method === "POST" && parts[2] === "steer") {
          const body = await readJson(req);
          const state = await controller.steer(missionId, body.message ?? "");
          await publish(missionId);
          return json(res, 200, state);
        }
        if (req.method === "GET" && parts[2] === "activity") return json(res, 200, await events.list(missionId));
        if (req.method === "GET" && parts[2] === "events") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive"
          });
          const set = subscribers.get(missionId) ?? new Set<ServerResponse>();
          set.add(res); subscribers.set(missionId, set);
          res.write(`event: mission.updated\ndata: ${JSON.stringify(await controller.state(missionId))}\n\n`);
          req.on("close", () => set.delete(res));
          return;
        }
      }
      json(res, 404, { error: "not_found" });
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
}

function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value));
}

async function readJson(req: AsyncIterable<any>) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
