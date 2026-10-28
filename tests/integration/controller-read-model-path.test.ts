import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

class NoReplayEventStore implements EventStore {
  listCalls = 0;
  private readonly delegate: EventStore;

  constructor(delegate: EventStore) {
    this.delegate = delegate;
  }

  append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    return this.delegate.append(event, expectedSequence);
  }

  async list(_missionId: string, _afterSequence = 0): Promise<MissionEvent[]> {
    this.listCalls += 1;
    throw new Error("full event replay is forbidden in this test path");
  }

  lastSequence(missionId: string): Promise<number> {
    return this.delegate.lastSequence(missionId);
  }
}

test("MissionController state/cycle use durable reader without full event replay when no recovery audit is required", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const durableStore = new SqliteEventStore(database);
  const seed = new MissionController(durableStore);
  const missionId = "mission-reader-controller";

  try {
    await seed.createMission(missionId, "complete from durable current state without replaying history");
    await seed.validateArtifact(missionId, "final-output@1", true);

    const noReplay = new NoReplayEventStore(durableStore);
    const reader = new SqliteMissionReader(database);
    const controller = new MissionController(
      noReplay,
      undefined,
      undefined,
      undefined,
      undefined,
      reader
    );

    const before = await controller.state(missionId);
    assert.equal(before.status, "active");
    assert.deepEqual(before.finalArtifactRefs, ["final-output@1"]);
    assert.equal(noReplay.listCalls, 0);

    const cycle = await controller.runControllerCycle({ missionId, trigger: "manual" });
    assert.equal(cycle.status, "completed");
    assert.equal(noReplay.listCalls, 0);

    const after = await reader.state(missionId);
    assert.equal(after.status, "completed");
    assert.equal(await durableStore.lastSequence(missionId), 5);
  } finally {
    database.close();
  }
});
