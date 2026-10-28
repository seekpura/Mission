import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentCreateRequest,
  AgentResumeRequest,
  ApprovalRequest,
  ApprovalResult,
  ContextDelta,
  EnvironmentSnapshot,
  HostAdapter,
  HostAgentEvent,
  HostAgentHandle,
  HostAgentResumeResult,
  HostCapabilityInvocation,
  HostCapabilityResult,
  HostDescriptor
} from "../../src/hosts/deepseek/host-adapter.ts";
import { createMissionRuntime } from "../../src/runtime/bootstrap.ts";
import { createMissionApi } from "../../src/server/mission-api.ts";
import { MISSION_JSON_BEGIN, MISSION_JSON_END } from "../../src/runtime/host-agent-json-transport.ts";

class ScriptedRuntimeHost implements HostAdapter {
  private nextId = 1;
  private readonly events = new Map<string, HostAgentEvent[]>();

  async describeHost(): Promise<HostDescriptor> {
    return { type: "scripted-runtime-host", version: "1" };
  }

  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [{
        id: "scripted.agent",
        kind: "agent",
        name: "Scripted Agent",
        description: "Scripted test host agent",
        hostNative: true,
        available: true,
        invocationRef: "scripted",
        permissions: ["host-agent-session"],
        scope: "host"
      }],
      shellAvailable: false,
      filesystemAvailable: true,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }

  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    const handle = { id: `scripted-${this.nextId++}`, nativeRef: `native-${this.nextId}` };
    const now = new Date().toISOString();
    if (request.workItemId.startsWith("control:")) {
      const response = controlResponse(request.workItemId);
      this.events.set(handle.id, [
        { type: "started", payload: { role: "control" }, at: now },
        {
          type: "message",
          payload: { content: { type: "text", text: `${MISSION_JSON_BEGIN}\n${JSON.stringify(response)}\n${MISSION_JSON_END}` } },
          at: now
        },
        { type: "completed", payload: { stopReason: "end_turn" }, at: now }
      ]);
      return handle;
    }

    const context = request.context as {
      executionContract?: {
        workspaceRoot?: string;
        outputManifest?: { path?: string };
      };
    };
    const workspaceRoot = context.executionContract?.workspaceRoot ?? request.workspaceRoot;
    const manifestPath = context.executionContract?.outputManifest?.path;
    if (!workspaceRoot || !manifestPath) throw new Error("Scripted worker requires Mission execution contract");
    const outputPath = join(workspaceRoot, "deliverable.txt");
    writeFileSync(outputPath, "verified scripted deliverable\n", "utf8");
    writeFileSync(manifestPath, JSON.stringify({
      outputs: [{
        path: "deliverable.txt",
        logicalName: "deliverable",
        type: "file",
        mimeType: "text/plain"
      }]
    }), "utf8");
    this.events.set(handle.id, [
      { type: "started", payload: { role: "worker" }, at: now },
      { type: "message", payload: { content: { type: "text", text: "worker completed artifact" } }, at: now },
      { type: "completed", payload: { stopReason: "end_turn" }, at: now }
    ]);
    return handle;
  }

  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "scripted host does not need restartable native sessions" };
  }

  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}

  async *observeAgent(handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {
    const events = this.events.get(handle.id);
    if (!events) throw new Error(`Unknown scripted handle: ${handle.id}`);
    for (const event of events) yield event;
    this.events.delete(handle.id);
  }

  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> {
    return { ok: false, error: "not used by scripted runtime host" };
  }

  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> {
    return { approved: false };
  }
}

function controlResponse(workItemId: string): unknown {
  if (workItemId.startsWith("control:strategy-")) {
    return {
      framing: "produce one independently verified deliverable",
      approach: "progressive single frontier",
      workstreams: [{ id: "delivery", objective: "produce the requested deliverable" }],
      revision: 1
    };
  }
  if (workItemId.startsWith("control:frontier-")) {
    return {
      graphRevision: 1,
      capabilityNeeds: [],
      workItems: [{
        id: "produce-deliverable",
        workstreamId: "delivery",
        purpose: "production",
        objective: "produce the requested deliverable",
        requirementRefs: ["req-deliverable"],
        gapRefs: [],
        inputArtifactRefs: [],
        expectedOutputs: [{ logicalName: "deliverable", type: "file", required: true }],
        localAcceptanceCriteria: [{
          id: "deliverable-real",
          description: "deliverable exists and contains non-empty useful content",
          priority: "critical"
        }],
        capabilityNeedRefs: [],
        priority: 100
      }]
    };
  }
  if (workItemId.startsWith("control:verify-")) {
    return {
      overall: "pass",
      checkResults: [{
        id: "mission-goal",
        status: "pass",
        detail: "The candidate artifact satisfies the requested deliverable contract.",
        evidenceRefs: ["evidence:scripted-independent-review"]
      }],
      evidenceRefs: ["evidence:scripted-independent-review"],
      gapAssessments: []
    };
  }
  if (workItemId.startsWith("control:completion-")) {
    return { blockingObjection: false, objections: [], confidence: 1 };
  }
  if (workItemId.startsWith("control:gap-")) {
    throw new Error("Scripted happy-path mission should not require gap diagnosis");
  }
  throw new Error(`Unexpected control request: ${workItemId}`);
}

function schemaPath() {
  return join(process.cwd(), "src", "persistence", "sqlite", "schema.sql");
}

async function listen(server: ReturnType<typeof createMissionApi>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP test server did not expose a TCP address");
  return `http://127.0.0.1:${address.port}`;
}

async function closeServer(server: ReturnType<typeof createMissionApi>): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

test("production runtime API automatically drives planner -> worker -> verifier -> completion", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-production-runtime-"));
  const runtime = createMissionRuntime({
    rootDir: root,
    schemaPath: schemaPath(),
    host: new ScriptedRuntimeHost(),
    executorId: "scripted-host",
    maxSupervisorCycles: 16
  });
  const server = createMissionApi(runtime.controller, runtime.events, {
    supervisor: runtime.supervisor,
    approvals: runtime.approvals
  });

  try {
    const base = await listen(server);
    const created = await fetch(`${base}/missions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ missionId: "mission-production-e2e", userGoal: "produce a verified deliverable" })
    });
    assert.equal(created.status, 201);

    await runtime.supervisor.waitForIdle("mission-production-e2e");
    const stateResponse = await fetch(`${base}/missions/mission-production-e2e`);
    assert.equal(stateResponse.status, 200);
    const state = await stateResponse.json() as { status: string; finalArtifactRefs: string[] };
    assert.equal(state.status, "completed");
    assert.deepEqual(state.finalArtifactRefs, ["deliverable@1"]);

    const activity = await (await fetch(`${base}/missions/mission-production-e2e/activity`)).json() as Array<{ type: string }>;
    const types = activity.map(event => event.type);
    assert.ok(types.includes("strategy.created"));
    assert.ok(types.includes("work.created"));
    assert.ok(types.includes("execution.bound"));
    assert.ok(types.includes("artifact.created"));
    assert.ok(types.includes("verification.completed"));
    assert.ok(types.includes("artifact.validated"));
    assert.ok(types.includes("mission.completed"));
  } finally {
    await closeServer(server);
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime startup catalog resumes a non-terminal persisted Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-production-restart-"));
  const dbPath = join(root, "persistent.db");
  const first = createMissionRuntime({
    rootDir: root,
    dbPath,
    schemaPath: schemaPath(),
    host: new ScriptedRuntimeHost(),
    executorId: "scripted-host"
  });

  try {
    await first.controller.createMission("mission-restart-e2e", "resume me after process restart");
  } finally {
    first.close();
  }

  const second = createMissionRuntime({
    rootDir: root,
    dbPath,
    schemaPath: schemaPath(),
    host: new ScriptedRuntimeHost(),
    executorId: "scripted-host",
    maxSupervisorCycles: 16
  });
  try {
    const resumed = await second.recoverExistingMissions();
    assert.deepEqual(resumed, ["mission-restart-e2e"]);
    await second.supervisor.waitForIdle("mission-restart-e2e");
    const state = await second.controller.state("mission-restart-e2e");
    assert.equal(state.status, "completed");
    assert.deepEqual(state.finalArtifactRefs, ["deliverable@1"]);
  } finally {
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});
