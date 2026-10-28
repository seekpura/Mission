import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

const state: MissionState = {
  missionId: "m1",
  status: "active",
  revision: 7,
  missionSpecRevision: 1,
  acceptanceRevision: 1,
  strategyRevision: 1,
  graphRevision: 1,
  environmentSnapshotRevision: 0,
  activeWorkstreamIds: [],
  activeWorkItemIds: ["w1"],
  readyWorkItemIds: [],
  blockedWorkItemIds: [],
  verifyingWorkItemIds: ["w1"],
  openGapIds: [],
  blockingGapIds: [],
  activeExecutionIds: [],
  pendingApprovalIds: [],
  finalArtifactRefs: [],
  lastEventSequence: 7
};

const workItem: WorkItem = {
  id: "w1",
  missionId: "m1",
  purpose: "production",
  objective: "Create a presentation that is structurally complete and visually reviewable",
  status: "verifying",
  requirementRefs: ["r1"],
  gapRefs: [],
  inputArtifactRefs: [],
  expectedOutputs: [{ logicalName: "deck", type: "presentation", required: true }],
  localAcceptanceCriteria: [{ id: "lac1", description: "All required sections are present", priority: "required" }],
  capabilityNeedRefs: [],
  priority: 1,
  graphRevision: 1,
  createdBy: "planner",
  createdAt: "2026-10-29T00:00:00.000Z",
  updatedAt: "2026-10-29T00:00:00.000Z"
};

function fixtureArtifact(root: string): Artifact {
  const uri = join(root, "deck.pptx");
  const bytes = Buffer.from("presentation fixture");
  writeFileSync(uri, bytes);
  return {
    id: "artifact-1",
    missionId: "m1",
    logicalName: "deck",
    type: "presentation",
    version: 1,
    status: "candidate",
    uri,
    contentHash: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sizeBytes: bytes.length,
    producedByAttemptId: "attempt-1",
    sourceArtifactRefs: [],
    createdAt: "2026-10-29T00:00:00.000Z"
  };
}

function fakeEvents() {
  return {
    async append() { throw new Error("not used"); },
    async list() { throw new Error("event replay must not be used when reader is supplied"); },
    async lastSequence() { return 0; }
  } as any;
}

function fakeReader() {
  return {
    async state() { return state; },
    async journal() { return { userGoal: "Deliver a polished presentation" } as any; },
    async latestStrategy() { return undefined; }
  };
}

class CapturingTransport implements HostJsonTransport {
  readonly requests: HostJsonRequest[] = [];
  constructor(private readonly response: (request: HostJsonRequest) => unknown) {}
  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return this.response(input);
  }
}

test("host verifier selects presentation profile and persists its profile id", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-profile-"));
  try {
    const artifact = fixtureArtifact(root);
    const transport = new CapturingTransport(request => {
      const profile = (request.input as any).verificationProfile;
      return {
        overall: "pass",
        checkResults: profile.checks.map((check: any) => ({
          id: check.id,
          status: "pass",
          evidenceRefs: [`review:${check.id}`]
        })),
        evidenceRefs: ["review:presentation"],
        gapAssessments: []
      };
    });
    const verifier = new HostArtifactVerifier({
      transport,
      events: fakeEvents(),
      reader: fakeReader()
    });

    const result = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(result.verificationProfileId, "presentation-mission-review-v1");
    assert.equal(result.overall, "pass");
    assert.equal(transport.requests.length, 1);
    const profile = (transport.requests[0].input as any).verificationProfile;
    assert.equal(profile.id, "presentation-mission-review-v1");
    assert.equal(profile.selectionReason, "artifact-type");
    assert.deepEqual(
      profile.checks.map((check: any) => check.id),
      ["presentation-structure", "presentation-visual-quality", "presentation-content-integrity", "presentation-delivery-integrity"]
    );
    assert.match(transport.requests[0].instruction, /Every required profile check id must appear exactly once/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host verifier fail-closes omitted required profile checks as inconclusive", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-profile-"));
  try {
    const artifact = fixtureArtifact(root);
    const transport = new CapturingTransport(() => ({
      overall: "pass",
      checkResults: [{ id: "presentation-structure", status: "pass", evidenceRefs: ["review:structure"] }],
      evidenceRefs: ["review:structure"],
      gapAssessments: []
    }));
    const verifier = new HostArtifactVerifier({
      transport,
      events: fakeEvents(),
      reader: fakeReader()
    });

    const result = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(result.overall, "inconclusive");
    assert.equal(result.verificationProfileId, "presentation-mission-review-v1");
    const missing = result.checkResults.filter(check => check.status === "inconclusive").map(check => check.id).sort();
    assert.deepEqual(missing, ["presentation-content-integrity", "presentation-delivery-integrity", "presentation-visual-quality"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
