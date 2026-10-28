import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { CapabilityNeed } from "../../src/core/domain/capability.ts";
import { HostDeliberationProvider } from "../../src/runtime/host-deliberation-provider.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

class RecordingTransport implements HostJsonTransport {
  requests: HostJsonRequest[] = [];

  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return {
      graphRevision: 1,
      capabilityNeeds: [],
      workItems: [{
        id: "work-uses-durable-need",
        purpose: "production",
        objective: "use the capability need reconstructed from durable Mission state",
        requirementRefs: [],
        gapRefs: [],
        inputArtifactRefs: [],
        expectedOutputs: [],
        localAcceptanceCriteria: [],
        capabilityNeedRefs: ["need-durable"],
        priority: 10
      }]
    };
  }
}

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

test("fresh planner session receives persisted strategy and all durable capability needs", async () => {
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const events = new SqliteEventStore(database);
  const controller = new MissionController(events);
  const missionId = "mission-planner-continuity";
  const need: CapabilityNeed = {
    id: "need-durable",
    missionId,
    objective: "provide a durable capability needed by a later frontier",
    requiredFunctions: ["durable-function"],
    desiredInputs: [],
    desiredOutputs: ["artifact"],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: false,
    maxRisk: "low",
    requirementRefs: [],
    gapRefs: []
  };

  try {
    await controller.createMission(missionId, "complete a multi-round mission without planner chat memory");
    await controller.emit(missionId, "strategy.created", {
      framing: "durable strategy framing",
      approach: "progressive durable planning",
      workstreams: [{ id: "stream-durable", objective: "continue across fresh planner sessions" }],
      revision: 1
    }, { type: "planner" }, "strategy-created:test");
    await controller.emit(missionId, "capability.need.created", {
      id: need.id,
      need
    }, { type: "planner" }, `capability-need:${need.id}`);

    const state = await controller.state(missionId);
    const transport = new RecordingTransport();
    const provider = new HostDeliberationProvider({
      transport,
      events,
      knownExecutorIds: ["host-default"],
      defaultExecutorId: "host-default"
    });

    const frontier = await provider.planFrontier({ state, openGaps: [] });
    assert.equal(transport.requests.length, 1);
    const mission = (transport.requests[0]!.input as { mission?: any }).mission;
    assert.equal(mission.strategy.framing, "durable strategy framing");
    assert.equal(mission.strategy.approach, "progressive durable planning");
    assert.deepEqual(mission.strategy.workstreams, [
      { id: "stream-durable", objective: "continue across fresh planner sessions" }
    ]);
    assert.equal(mission.capabilityNeeds.length, 1);
    assert.equal(mission.capabilityNeeds[0].id, "need-durable");
    assert.deepEqual(mission.capabilityNeeds[0].requiredFunctions, ["durable-function"]);

    assert.equal(frontier.workItems.length, 1);
    assert.deepEqual(frontier.workItems[0]!.capabilityNeedRefs, ["need-durable"]);
    assert.equal(frontier.workItems[0]!.assignedExecutorId, "host-default");
  } finally {
    database.close();
  }
});
