import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityDescriptor, CapabilityNeed } from "../../src/core/domain/capability.ts";
import type {
  WorkExecutionDriver,
  WorkExecutionInput,
  WorkExecutionOutcome
} from "../../src/core/execution/work-execution-driver.ts";
import type { CapabilityEnsureResult, CapabilityRuntime } from "../../src/core/capabilities/capability-coordinator.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import type { DeliberationProvider, FrontierProposal } from "../../src/core/planning/deliberation-provider.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";

const missionId = "mission-capability-runtime";

function capabilityNeed(id = "need-render"): CapabilityNeed {
  return {
    id,
    missionId,
    objective: "Render the requested artifact",
    requiredFunctions: ["render presentation"],
    desiredInputs: ["document"],
    desiredOutputs: ["presentation"],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "medium",
    requirementRefs: ["req-render"],
    gapRefs: []
  };
}

function workItem(id: string, needRef = "need-render") {
  const now = new Date().toISOString();
  return {
    id,
    missionId,
    purpose: "production" as const,
    objective: "Produce work using the required renderer",
    status: "ready" as const,
    requirementRefs: [],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [],
    localAcceptanceCriteria: [],
    capabilityNeedRefs: [needRef],
    priority: 10,
    graphRevision: 0,
    createdBy: "planner" as const,
    createdAt: now,
    updatedAt: now
  };
}

class OneFrontierProvider implements DeliberationProvider {
  private planned = false;
  private readonly proposal: FrontierProposal;

  constructor(proposal: FrontierProposal) {
    this.proposal = proposal;
  }

  async composeStrategy() {
    return {
      framing: "Capability-aware execution",
      approach: "Resolve missing capability before dispatch",
      workstreams: [{ id: "ws-1", objective: "Produce output" }],
      revision: 1
    };
  }

  async planFrontier() {
    if (this.planned) return { workItems: [], capabilityNeeds: [], graphRevision: 1 };
    this.planned = true;
    return this.proposal;
  }

  async diagnoseGap(input: any) {
    return {
      gapId: input.gap.id,
      rootCause: "Capability unavailable",
      intervention: "replace_capability" as const,
      confidence: 1
    };
  }

  async challengeCompletion() {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
}

class RecordingExecutionDriver implements WorkExecutionDriver {
  readonly id = "recording-driver";
  readonly calls: WorkExecutionInput[] = [];

  async execute(input: WorkExecutionInput): Promise<WorkExecutionOutcome> {
    this.calls.push(input);
    const now = new Date().toISOString();
    return {
      result: {
        executionId: input.executionId,
        state: "succeeded",
        producedFiles: [],
        committedArtifactRefs: [],
        sideEffects: [],
        startedAt: now,
        endedAt: now
      },
      artifacts: []
    };
  }
}

class AcquiringRuntime implements CapabilityRuntime {
  readonly ensureCalls: string[] = [];
  readonly restored: CapabilityDescriptor[] = [];
  private readonly acquired: CapabilityDescriptor;

  constructor(capabilityId = "acquired:presentation-renderer") {
    this.acquired = {
      id: capabilityId,
      kind: "skill",
      name: "Presentation Renderer",
      description: "Render presentation files",
      hostNative: false,
      available: true,
      invocationRef: "/mission/capabilities/presentation-renderer",
      permissions: [],
      revision: "commit-1",
      scope: "mission"
    };
  }

  restoreMissionCapabilities(_missionId: string, capabilities: Iterable<CapabilityDescriptor>): void {
    this.restored.splice(0, this.restored.length, ...capabilities);
  }

  async ensure(need: CapabilityNeed): Promise<CapabilityEnsureResult> {
    this.ensureCalls.push(need.id);
    const restored = this.restored.find(capability => capability.id === this.acquired.id);
    return {
      status: "resolved",
      capability: restored ?? this.acquired,
      source: restored ? "host-or-overlay" : "acquired",
      attempts: restored ? [] : [{ candidateId: "candidate-1", candidateName: "renderer", ok: true }],
      reason: restored ? "Restored mission-local capability" : "Acquired renderer"
    };
  }
}

function createStore() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  return { db, store: new SqliteEventStore(db) };
}

test("planner capability need is persisted, acquired before attempt, and injected into worker context", async () => {
  const { db, store } = createStore();
  const driver = new RecordingExecutionDriver();
  const runtime = new AcquiringRuntime();
  const need = capabilityNeed();
  const provider = new OneFrontierProvider({
    capabilityNeeds: [need],
    workItems: [workItem("work-1")],
    graphRevision: 1
  });
  const controller = new MissionController(store, provider, driver, undefined, runtime);

  try {
    await controller.createMission(missionId, "Produce a presentation with whatever capability is required");
    const cycle = await controller.runControllerCycle({ missionId, trigger: "mission_created" });

    assert.equal(cycle.executionsDispatched.length, 1);
    assert.deepEqual(runtime.ensureCalls, ["need-render"]);
    assert.equal(driver.calls.length, 1);
    assert.deepEqual(driver.calls[0]?.contextPacket.allowedCapabilityRefs, ["acquired:presentation-renderer"]);

    const events = await store.list(missionId);
    const eventTypes = events.map(event => event.type);
    const needIndex = eventTypes.indexOf("capability.need.created");
    const workIndex = eventTypes.indexOf("work.created");
    const activatedIndex = eventTypes.indexOf("capability.activated");
    const attemptIndex = eventTypes.indexOf("attempt.created");
    assert.ok(needIndex >= 0 && needIndex < workIndex);
    assert.ok(workIndex < activatedIndex);
    assert.ok(activatedIndex < attemptIndex);

    const attempt = events.find(event => event.type === "attempt.created");
    assert.deepEqual((attempt?.payload as any)?.capabilityRefs, ["acquired:presentation-renderer"]);
    const activated = events.find(event => event.type === "capability.activated");
    assert.equal((activated?.payload as any)?.capability?.revision, "commit-1");
  } finally {
    db.close();
  }
});

test("activated non-host capability is restored from mission journal after controller restart", async () => {
  const { db, store } = createStore();
  const firstDriver = new RecordingExecutionDriver();
  const firstRuntime = new AcquiringRuntime();
  const provider = new OneFrontierProvider({
    capabilityNeeds: [capabilityNeed()],
    workItems: [workItem("work-first")],
    graphRevision: 1
  });

  try {
    const first = new MissionController(store, provider, firstDriver, undefined, firstRuntime);
    await first.createMission(missionId, "Produce two capability-backed tasks");
    await first.runControllerCycle({ missionId, trigger: "mission_created" });

    await first.proposeWork(workItem("work-after-restart"));

    const secondRuntime = new AcquiringRuntime();
    const secondDriver = new RecordingExecutionDriver();
    const second = new MissionController(store, undefined, secondDriver, undefined, secondRuntime);
    await second.runControllerCycle({ missionId, trigger: "manual" });

    assert.equal(secondRuntime.restored.some(capability => capability.id === "acquired:presentation-renderer"), true);
    assert.deepEqual(secondDriver.calls[0]?.contextPacket.allowedCapabilityRefs, ["acquired:presentation-renderer"]);
    assert.equal(secondRuntime.ensureCalls.includes("need-render"), true);
  } finally {
    db.close();
  }
});

test("work requiring a capability is blocked before attempt creation when no capability runtime is configured", async () => {
  const { db, store } = createStore();
  const driver = new RecordingExecutionDriver();
  const provider = new OneFrontierProvider({
    capabilityNeeds: [capabilityNeed()],
    workItems: [workItem("work-blocked")],
    graphRevision: 1
  });
  const controller = new MissionController(store, provider, driver);

  try {
    await controller.createMission(missionId, "Require a capability but omit runtime");
    const cycle = await controller.runControllerCycle({ missionId, trigger: "mission_created" });

    assert.deepEqual(cycle.executionsDispatched, []);
    assert.equal(driver.calls.length, 0);
    const state = await controller.state(missionId);
    assert.deepEqual(state.blockedWorkItemIds, ["work-blocked"]);
    assert.equal(state.blockingGapIds.some(id => id === "capability-gap:work-blocked:need-render"), true);

    const types = (await store.list(missionId)).map(event => event.type);
    assert.equal(types.includes("attempt.created"), false);
    assert.equal(types.includes("execution.started"), false);
  } finally {
    db.close();
  }
});

test("planner cannot create work with a dangling capabilityNeedRef", async () => {
  const { db, store } = createStore();
  const provider = new OneFrontierProvider({
    workItems: [workItem("work-dangling", "missing-need")],
    graphRevision: 1
  });
  const controller = new MissionController(store, provider);

  try {
    await controller.createMission(missionId, "Reject dangling capability references");
    await assert.rejects(
      controller.runControllerCycle({ missionId, trigger: "mission_created" }),
      /references unknown capability need missing-need/
    );
    const types = (await store.list(missionId)).map(event => event.type);
    assert.equal(types.includes("work.created"), false);
  } finally {
    db.close();
  }
});
