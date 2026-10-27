import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";

const db = new MissionDatabase(":memory:");
db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
const store = new SqliteEventStore(db);
const controller = new MissionController(store);
await controller.createMission("smoke", "prove mission durability and completion gating");
await controller.openGap("smoke", { id: "g1", severity: "major", description: "verification gap" });
await controller.resolveGap("smoke", "g1");
await controller.validateArtifact("smoke", "artifact@2", true);
const state = await controller.completeIfEligible("smoke");
console.log(JSON.stringify({ state, events: await store.list("smoke") }, null, 2));
if (state.status !== "completed") process.exitCode = 1;
db.close();
