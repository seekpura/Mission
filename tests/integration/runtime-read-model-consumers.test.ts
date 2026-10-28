import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { SqliteMissionReader } from "../../src/persistence/sqlite/sqlite-mission-reader.ts";
import { HostDeliberationProvider } from "../../src/runtime/host-deliberation-provider.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

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

class PlannerTransport implements HostJsonTransport {
  requests: HostJsonRequest[] = [];
  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return { graphRevision: 2, capabilityNeeds: [], workItems: [] };
  }
}

class VerifierTransport implements HostJsonTransport {
  requests: HostJsonRequest[] = [];
  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    const profile = (input.input as { verificationProfile?: { checks?: Array<{ id?: string }> } }).verificationProfile;
    const checks = profile?.checks ?? [];
    return {
      overall: "pass",
      checkResults: checks.map(check => ({
        id: check.id,
        status: "pass",
        evidenceRefs: ["evidence:artifact-content"]
      })),
      evidenceRefs: ["evidence:artifact-content"],
      gapAssessments: []
    };
  }
}

function work(missionId: string): WorkItem {
  const now = new Date().toISOString();
  return {
    id: "work-read-model-consumer",
    missionId,
    purpose: "production",
    objective: "produce a verified durable-read-model deliverable",
    status: "ready",
    requirementRefs: ["req-read-model"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
    localAcceptanceCriteria: [{ id: "criterion-1", description: "deliverable is non-empty", priority: "required" }],
    capabilityNeedRefs: [],
    assignedExecutorId: "host-default",
    priority: 10,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: now,
    updatedAt: now
  };
}

test("host planner and independent verifier read Mission context without replaying the event log", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-read-model-consumers-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(schemaPath());
  const durableStore = new SqliteEventStore(database);
  const seed = new MissionController(durableStore);
  const missionId = "mission-read-model-consumers";

  try {
    await seed.createMission(missionId, "prove planner and verifier continuity from durable current views");
    await seed.emit(missionId, "strategy.created", {
      framing: "durable current-view strategy",
      approach: "progressive",
      workstreams: [{ id: "stream-1", objective: "produce and verify" }],
      revision: 1
    }, { type: "planner" }, "strategy-created:read-model-consumers");
    await seed.proposeWork(work(missionId));

    const noReplay = new NoReplayEventStore(durableStore);
    const reader = new SqliteMissionReader(database);
    const state = await reader.state(missionId);

    const plannerTransport = new PlannerTransport();
    const planner = new HostDeliberationProvider({
      transport: plannerTransport,
      events: noReplay,
      reader,
      knownExecutorIds: ["host-default"],
      defaultExecutorId: "host-default"
    });
    const frontier = await planner.planFrontier({ state, openGaps: [] });
    assert.deepEqual(frontier.workItems, []);
    assert.equal(noReplay.listCalls, 0);
    const plannerMission = (plannerTransport.requests[0]!.input as { mission?: any }).mission;
    assert.equal(plannerMission.userGoal, "prove planner and verifier continuity from durable current views");
    assert.equal(plannerMission.strategy.framing, "durable current-view strategy");
    assert.equal(plannerMission.workItems[0].id, "work-read-model-consumer");

    const artifactPath = join(root, "deliverable.txt");
    const content = "durable read model verified artifact\n";
    await writeFile(artifactPath, content, "utf8");
    const artifact: Artifact = {
      id: "deliverable",
      missionId,
      logicalName: "deliverable",
      type: "file",
      version: 1,
      status: "candidate",
      uri: artifactPath,
      contentHash: createHash("sha256").update(content).digest("hex"),
      sizeBytes: Buffer.byteLength(content),
      producedByAttemptId: "attempt-read-model",
      sourceArtifactRefs: [],
      createdAt: new Date().toISOString()
    };
    const verifierTransport = new VerifierTransport();
    const verifier = new HostArtifactVerifier({
      transport: verifierTransport,
      events: noReplay,
      reader
    });
    const result = await verifier.verify(artifact, {
      state,
      workItem: work(missionId),
      gaps: []
    });
    assert.equal(result.level, "mission");
    assert.equal(result.overall, "pass");
    assert.equal(result.verificationProfileId, "generic-mission-review-v1");
    assert.equal(noReplay.listCalls, 0);
    assert.equal((verifierTransport.requests[0]!.input as { userGoal?: string }).userGoal,
      "prove planner and verifier continuity from durable current views");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
