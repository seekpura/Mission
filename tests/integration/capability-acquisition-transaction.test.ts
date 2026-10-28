import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CapabilityCandidate, CapabilityNeed } from "../../src/core/domain/capability.ts";
import {
  CapabilityAcquisitionError,
  CapabilityAcquisitionTransaction
} from "../../src/core/capabilities/acquisition-transaction.ts";
import { FileAcquisitionReceiptStore } from "../../src/core/capabilities/acquisition-receipt.ts";
import {
  RepositoryCapabilityMaterializer,
  type RepositorySnapshotClient
} from "../../src/core/capabilities/materialization.ts";
import { MissionLocalDirectoryActivator } from "../../src/core/capabilities/mission-local-directory-activator.ts";
import { MissionCapabilityOverlay } from "../../src/core/capabilities/mission-capability-overlay.ts";
import { SandboxManager } from "../../src/core/capabilities/sandbox/sandbox-manager.ts";
import {
  IsolatedCapabilitySmokeRunner,
  type CapabilitySmokePlanResolver,
  type IsolatedSmokeExecutor,
  type SmokeExecutionResult,
  type SmokeIsolationLevel
} from "../../src/core/capabilities/sandbox/isolated-smoke-runner.ts";

class FixtureSnapshotClient implements RepositorySnapshotClient {
  private readonly contents: string;
  readonly revision: string;

  constructor(contents: string, revision = "commit-abc123") {
    this.contents = contents;
    this.revision = revision;
  }

  async snapshot(input: {
    sourceUri: string;
    targetDirectory: string;
    requestedRevision?: string;
  }): Promise<{ resolvedRevision: string }> {
    writeFileSync(join(input.targetDirectory, "SKILL.md"), this.contents, "utf8");
    writeFileSync(join(input.targetDirectory, "metadata.json"), JSON.stringify({ source: input.sourceUri }), "utf8");
    return { resolvedRevision: input.requestedRevision ?? this.revision };
  }
}

class RecordingSmokeExecutor implements IsolatedSmokeExecutor {
  readonly id: string;
  readonly isolationLevel: SmokeIsolationLevel;
  calls = 0;
  private readonly result: SmokeExecutionResult;

  constructor(
    isolationLevel: SmokeIsolationLevel = "container",
    result: SmokeExecutionResult = { exitCode: 0, timedOut: false, stdout: "ok", stderr: "" }
  ) {
    this.id = `smoke-${isolationLevel}`;
    this.isolationLevel = isolationLevel;
    this.result = result;
  }

  async execute(input: {
    cwd: string;
    command: string;
    args: string[];
    timeoutMs?: number;
    env: Record<string, string>;
  }): Promise<SmokeExecutionResult> {
    this.calls += 1;
    assert.equal(existsSync(join(input.cwd, "SKILL.md")), true);
    return this.result;
  }
}

const smokeResolver: CapabilitySmokePlanResolver = {
  async resolve() {
    return { command: "capability-smoke", args: ["--check"], timeoutMs: 2_000 };
  }
};

function candidate(id = "candidate-1"): CapabilityCandidate {
  return {
    id,
    sourceType: "github",
    sourceUri: "https://github.com/example/capability",
    name: "example/capability",
    description: "Example external capability",
    candidateKind: "skill",
    status: "discovered"
  };
}

function need(maxRisk: CapabilityNeed["maxRisk"] = "medium"): CapabilityNeed {
  return {
    id: "need-1",
    missionId: "mission-acquisition",
    objective: "Acquire a missing verification capability",
    requiredFunctions: ["verify artifact"],
    desiredInputs: ["file"],
    desiredOutputs: ["verification result"],
    purpose: "verification",
    urgency: "blocking",
    acquisitionAllowed: true,
    maxRisk,
    requirementRefs: ["req-verify"],
    gapRefs: ["gap-capability"]
  };
}

function setup(root: string, contents: string, smokeExecutor = new RecordingSmokeExecutor()) {
  const overlay = new MissionCapabilityOverlay();
  const receiptStore = new FileAcquisitionReceiptStore(join(root, "receipts"));
  const transaction = new CapabilityAcquisitionTransaction({
    materializer: new RepositoryCapabilityMaterializer({
      stagingRoot: join(root, "staging"),
      client: new FixtureSnapshotClient(contents)
    }),
    sandboxManager: new SandboxManager(join(root, "sandboxes")),
    smokeRunner: new IsolatedCapabilitySmokeRunner(smokeExecutor, smokeResolver),
    activator: new MissionLocalDirectoryActivator(join(root, "activated")),
    overlay,
    receiptStore
  });
  return { transaction, overlay, receiptStore, smokeExecutor };
}

test("capability acquisition pins revision/hash, runs isolated smoke, activates mission-locally and writes receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-acquire-success-"));
  try {
    const { transaction, overlay, receiptStore, smokeExecutor } = setup(
      root,
      "# Example Skill\nRead files and return a verification summary.\n"
    );

    const outcome = await transaction.acquire(candidate(), need("low"));

    assert.equal(outcome.receipt.status, "activated");
    assert.equal(outcome.receipt.resolvedRevision, "commit-abc123");
    assert.match(outcome.receipt.contentHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(outcome.receipt.security.overall, "low");
    assert.equal(outcome.receipt.smoke?.passed, true);
    assert.equal(outcome.receipt.smoke?.isolationLevel, "container");
    assert.equal(smokeExecutor.calls, 1);

    assert.equal(outcome.capability.scope, "mission");
    assert.equal(outcome.capability.hostNative, false);
    assert.equal(outcome.capability.revision, "commit-abc123");
    assert.ok(outcome.capability.invocationRef);
    assert.equal(existsSync(join(outcome.capability.invocationRef!, "SKILL.md")), true);
    assert.match(readFileSync(join(outcome.capability.invocationRef!, "SKILL.md"), "utf8"), /Example Skill/);

    assert.deepEqual(overlay.list("mission-acquisition").map(item => item.id), [outcome.capability.id]);
    const receipts = receiptStore.list("mission-acquisition");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "activated");

    assert.deepEqual(readdirSync(join(root, "staging")), []);
    assert.deepEqual(readdirSync(join(root, "sandboxes")), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("capability acquisition rejects a candidate whose static risk exceeds the need maxRisk before smoke", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-acquire-risk-"));
  try {
    const { transaction, overlay, receiptStore, smokeExecutor } = setup(
      root,
      "const child_process = require('child_process');\n"
    );

    await assert.rejects(
      transaction.acquire(candidate("candidate-risk"), need("low")),
      (error: unknown) => error instanceof CapabilityAcquisitionError && /exceeds need maxRisk/.test(error.message)
    );

    assert.equal(smokeExecutor.calls, 0);
    assert.deepEqual(overlay.list("mission-acquisition"), []);
    const receipts = receiptStore.list("mission-acquisition");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "rejected");
    assert.equal(receipts[0]?.security.overall, "medium");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("high-risk acquisition requires and records approval before any smoke execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-acquire-approval-"));
  try {
    const overlay = new MissionCapabilityOverlay();
    const receiptStore = new FileAcquisitionReceiptStore(join(root, "receipts"));
    const smokeExecutor = new RecordingSmokeExecutor("container");
    let approvals = 0;
    const transaction = new CapabilityAcquisitionTransaction({
      materializer: new RepositoryCapabilityMaterializer({
        stagingRoot: join(root, "staging"),
        client: new FixtureSnapshotClient("Read ~/.ssh material for setup.\n")
      }),
      sandboxManager: new SandboxManager(join(root, "sandboxes")),
      smokeRunner: new IsolatedCapabilitySmokeRunner(smokeExecutor, smokeResolver),
      activator: new MissionLocalDirectoryActivator(join(root, "activated")),
      overlay,
      receiptStore,
      approvalBroker: {
        async requestApproval(request) {
          approvals += 1;
          assert.match(String(request.details.contentHash), /^sha256:/);
          return { approved: false, actor: "test-user" };
        }
      }
    });

    await assert.rejects(
      transaction.acquire(candidate("candidate-high"), need("high")),
      /User approval rejected/
    );

    assert.equal(approvals, 1);
    assert.equal(smokeExecutor.calls, 0);
    assert.deepEqual(overlay.list("mission-acquisition"), []);
    const receipts = receiptStore.list("mission-acquisition");
    assert.equal(receipts[0]?.status, "approval_rejected");
    assert.equal(receipts[0]?.approval?.approved, false);
    assert.equal(receipts[0]?.approval?.actor, "test-user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external capability code cannot smoke on a host/process-only executor and the failure is receipted", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-acquire-isolation-"));
  try {
    const weakExecutor = new RecordingSmokeExecutor("process");
    const { transaction, overlay, receiptStore } = setup(
      root,
      "# Low-risk skill\nNo executable code required for this fixture.\n",
      weakExecutor
    );

    await assert.rejects(
      transaction.acquire(candidate("candidate-weak-isolation"), need("low")),
      /requires restricted\/container\/vm\/remote isolation/
    );

    assert.equal(weakExecutor.calls, 0);
    assert.deepEqual(overlay.list("mission-acquisition"), []);
    const receipts = receiptStore.list("mission-acquisition");
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]?.status, "smoke_failed");
    assert.match(receipts[0]?.reason ?? "", /requires restricted\/container\/vm\/remote isolation/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
