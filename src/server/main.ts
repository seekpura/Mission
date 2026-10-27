import { join } from "node:path";
import { MissionDatabase } from "../persistence/sqlite/database.ts";
import { SqliteEventStore } from "../persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../core/mission/controller.ts";
import { createMissionApi } from "./mission-api.ts";

const dbPath = process.env.MISSION_DB ?? join(process.cwd(), ".mission", "mission.db");
const schemaPath = join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
const database = new MissionDatabase(dbPath);
database.migrate(schemaPath);
const events = new SqliteEventStore(database);
const controller = new MissionController(events);
const port = Number(process.env.PORT ?? 8787);
const server = createMissionApi(controller, events);
server.listen(port, "127.0.0.1", () => console.log(`Mission Runtime listening on http://127.0.0.1:${port}`));
