import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityNeed } from "../../src/core/domain/capability.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import type {
  IsolatedSmokeExecutor,
  SmokeExecutionResult
} from "../../src/core/capabilities/sandbox/isolated-smoke-runner.ts";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
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
import { RuntimeApprovalManager } from "../../src/runtime/approval-manager.ts";
import { MissionAgentSkillContextResolver } from "../../src/runtime/agent-skill-runtime.ts";
import { CapabilityContextHostAdapter } from "../../src/runtime/capability-context-host-adapter.ts";
import { GitHubCapabilityClient } from "../../src/runtime/github-capability-client.ts";
import { createProductionAgentSkillCapabilityRuntime } from "../../src/runtime/production-capability-runtime.ts";

const COMMIT_SHA = "a".repeat(40);
const TREE_SHA = "b".repeat(40);
const BLOB_SHA = "c".repeat(40);
const SKILL = "# Verified Skill\nWhen asked for the deliverable, verify source truth first and cite the evidence used.\n";

class RecordingContainerSmoke implements IsolatedSmokeExecutor {
  readonly id = "recording-container-smoke";
  readonly isolationLevel = "container" as const;
  calls = 0;

  async execute(input: {
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
    env: Record<string, string>;
  }): Promise<SmokeExecutionResult> {
    this.calls += 1;
    assert.equal(input.command, "/bin/sh");
    assert.equal(existsSync(join(input.cwd, "SKILL.md")), true);
    assert.equal(readFileSync(join(input.cwd, "SKILL.md"), "utf8"), SKILL);
    return { exitCode: 0, timedOut: false, stdout: "skill-ok", stderr: "" };
  }
}

class RecordingHost implements HostAdapter {
  lastCreate?: AgentCreateRequest;

  async describeHost(): Promise<HostDescriptor> { return { type: "recording-host" }; }
  async snapshotEnvironment(): Promise<EnvironmentSnapshot> {
    return {
      revision: 1,
      host: await this.describeHost(),
      capabilities: [],
      shellAvailable: false,
      filesystemAvailable: false,
      browserAvailable: false,
      capturedAt: new Date().toISOString()
    };
  }
  async createAgent(request: AgentCreateRequest): Promise<HostAgentHandle> {
    this.lastCreate = request;
    return { id: "recording-agent" };
  }
  async resumeAgent(_request: AgentResumeRequest): Promise<HostAgentResumeResult> {
    return { status: "unsupported", reason: "not required" };
  }
  async steerAgent(_handle: HostAgentHandle, _delta: ContextDelta): Promise<void> {}
  async cancelAgent(_handle: HostAgentHandle): Promise<void> {}
  async *observeAgent(_handle: HostAgentHandle): AsyncIterable<HostAgentEvent> {}
  async invokeHostCapability(_request: HostCapabilityInvocation): Promise<HostCapabilityResult> { return { ok: false }; }
  async requestUserApproval(_request: ApprovalRequest): Promise<ApprovalResult> { return { approved: false }; }
}

function githubFetch(): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname === "/search/repositories") {
      return response({ items: [{
        full_name: "example/verified-skill",
        description: "Agent skill for verified source-truth evidence work",
        html_url: "https://github.com/example/verified-skill",
        default_branch: "main",
        stargazers_count: 10
      }] });
    }
    if (url.pathname === "/repos/example/verified-skill") {
      return response({
        full_name: "example/verified-skill",
        description: "Agent skill for verified source-truth evidence work",
        html_url: "https://github.com/example/verified-skill",
        default_branch: "main",
        stargazers_count: 10
      });
    }
    if (url.pathname === "/repos/example/verified-skill/commits/main") {
      return response({ sha: COMMIT_SHA, commit: { tree: { sha: TREE_SHA } } });
    }
    if (url.pathname === `/repos/example/verified-skill/git/trees/${TREE_SHA}`) {
      return response({
        truncated: false,
        tree: [{ path: "SKILL.md", mode: "100644", type: "blob", sha: BLOB_SHA, size: Buffer.byteLength(SKILL) }]
      });
    }
    if (url.pathname === `/repos/example/verified-skill/git/blobs/${BLOB_SHA}`) {
      return response({ encoding: "base64", content: Buffer.from(SKILL).toString("base64"), size: Buffer.byteLength(SKILL) });
    }
    throw new Error(`Unexpected GitHub request: ${url.pathname}${url.search}`);
  }) as typeof fetch;
}

function response(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function need(missionId: string): CapabilityNeed {
  return {
    id: "need-verified-skill",
    missionId,
    objective: "Use a verified source-truth Agent Skill for evidence work",
    requiredFunctions: ["verified source truth evidence"],
    desiredInputs: ["source material"],
    desiredOutputs: ["verified deliverable"],
    purpose: "production",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk: "low",
    requirementRefs: ["req-evidence"],
    gapRefs: []
  };
}

async function pendingSkillApproval(approvals: RuntimeApprovalManager, missionId: string) {
  let pending = await approvals.listPending(missionId);
  for (let attempt = 0; pending.length === 0 && attempt < 100; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    pending = await approvals.listPending(missionId);
  }
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.kind, "acquisition");
  assert.match(pending[0]?.reason ?? "", /External Agent Skill instructions require explicit approval/);
  return pending[0]!;
}

test("production Agent Skill acquisition requires approval, activates mission-locally and injects only the authorized skill into Host context", async () => {
  const root = await mkdtemp(join(tmpdir(), "mission-production-skill-"));
  const database = new MissionDatabase(":memory:");
  database.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const events = new SqliteEventStore(database);
  const approvals = new RuntimeApprovalManager(events, { timeoutMs: 5_000 });
  const overlay = new MissionCapabilityOverlay();
  const baseHost = new RecordingHost();
  const github = new GitHubCapabilityClient({ fetchImpl: githubFetch() });
  const smoke = new RecordingContainerSmoke();
  const missionId = "mission-production-skill";

  try {
    const runtime = createProductionAgentSkillCapabilityRuntime({
      rootDir: join(root, "capabilities"),
      host: baseHost,
      overlay,
      approvals,
      githubClient: github,
      smokeExecutor: smoke,
      dockerImage: "unused-test-image"
    });
    const ensurePromise = runtime.ensure(need(missionId));
    const pending = await pendingSkillApproval(approvals, missionId);
    assert.equal(smoke.calls, 0, "isolated smoke must not start while explicit approval is still pending");
    await approvals.decide(missionId, pending.id, {
      approved: true,
      scope: "once",
      actor: "test-user",
      reason: "Explicitly approve this pinned external Agent Skill for the Mission"
    });

    const ensured = await ensurePromise;
    assert.equal(ensured.status, "resolved");
    assert.equal(ensured.source, "acquired");
    assert.equal(smoke.calls, 1);
    const capability = ensured.capability!;
    assert.equal(capability.kind, "skill");
    assert.equal(capability.scope, "mission");
    assert.equal(capability.revision, COMMIT_SHA);
    assert.ok(capability.invocationRef);
    assert.equal(readFileSync(join(capability.invocationRef!, "SKILL.md"), "utf8"), SKILL);
    assert.deepEqual(overlay.list(missionId).map(item => item.id), [capability.id]);

    const acquisitionEvents = await events.list(missionId);
    const requestedIndex = acquisitionEvents.findIndex(event => event.type === "approval.requested");
    const decidedIndex = acquisitionEvents.findIndex(event => event.type === "approval.decided");
    assert.ok(requestedIndex >= 0 && decidedIndex > requestedIndex);

    const host = new CapabilityContextHostAdapter(
      baseHost,
      new MissionAgentSkillContextResolver(overlay)
    );
    await host.createAgent({
      missionId,
      workItemId: "work-use-skill",
      context: { objective: "produce with acquired skill" },
      allowedCapabilityRefs: [capability.id],
      workspaceRoot: root
    });

    const delivered = (baseHost.lastCreate?.context as {
      missionCapabilityContext?: Array<{
        id: string;
        revision: string;
        contentHash: string;
        instructions: string;
      }>;
    }).missionCapabilityContext;
    assert.equal(delivered?.length, 1);
    assert.equal(delivered?.[0]?.id, capability.id);
    assert.equal(delivered?.[0]?.revision, COMMIT_SHA);
    assert.match(delivered?.[0]?.contentHash ?? "", /^sha256:[0-9a-f]{64}$/);
    assert.equal(delivered?.[0]?.instructions, SKILL);

    await host.createAgent({
      missionId,
      workItemId: "work-without-skill",
      context: { objective: "do not receive unreferenced skill" },
      allowedCapabilityRefs: [],
      workspaceRoot: root
    });
    assert.equal((baseHost.lastCreate?.context as { missionCapabilityContext?: unknown }).missionCapabilityContext, undefined);
  } finally {
    approvals.dispose();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
