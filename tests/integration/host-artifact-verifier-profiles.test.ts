import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import {
  VerificationEvidenceCollectorRegistry,
  type VerificationEvidenceCollector
} from "../../src/core/verification/evidence-collector.ts";
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

class MemoryEvents implements EventStore {
  readonly events: MissionEvent[] = [];

  async append<T>(event: Omit<MissionEvent<T>, "sequence">, expectedSequence: number): Promise<MissionEvent<T>> {
    const scoped = this.events.filter(item => item.missionId === event.missionId);
    if (event.idempotencyKey) {
      const duplicate = scoped.find(item => item.idempotencyKey === event.idempotencyKey);
      if (duplicate) return duplicate as MissionEvent<T>;
    }
    assert.equal(scoped.length, expectedSequence);
    const committed = { ...event, sequence: scoped.length + 1 } as MissionEvent<T>;
    this.events.push(committed as MissionEvent);
    return committed;
  }

  async list(missionId: string, afterSequence = 0): Promise<MissionEvent[]> {
    return this.events.filter(event => event.missionId === missionId && event.sequence > afterSequence);
  }

  async lastSequence(missionId: string): Promise<number> {
    return this.events.filter(event => event.missionId === missionId).length;
  }
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
  private readonly response: (request: HostJsonRequest) => unknown;

  constructor(response: (request: HostJsonRequest) => unknown) {
    this.response = response;
  }

  async request(input: HostJsonRequest): Promise<unknown> {
    this.requests.push(input);
    return this.response(input);
  }
}

function presentationEvidenceCollectors(includeRender = true): VerificationEvidenceCollectorRegistry {
  const collector: VerificationEvidenceCollector = {
    id: includeRender ? "fixture-presentation-full" : "fixture-presentation-package-only",
    kinds: includeRender
      ? ["file-integrity", "presentation-package", "presentation-render"]
      : ["file-integrity", "presentation-package"],
    supports: () => true,
    collect: () => [
      {
        type: "file-validation",
        kind: "file-integrity",
        claim: "Fixture artifact bytes were validated by the test collector.",
        result: "supports",
        details: { fixture: true }
      },
      {
        type: "source",
        kind: "presentation-package",
        claim: "Fixture presentation structure was inspected by the test collector.",
        result: "supports",
        details: { slideCount: 3 }
      },
      ...(includeRender ? [{
        type: "render-inspection" as const,
        kind: "presentation-render" as const,
        claim: "Fixture rendered slides were visually inspected by the test collector.",
        result: "supports" as const,
        details: { renderedSlides: 3 },
        inspectionPayload: { frames: ["slide-1", "slide-2", "slide-3"] }
      }] : [])
    ]
  };
  return new VerificationEvidenceCollectorRegistry([collector]);
}

function runtimeRefs(request: HostJsonRequest): string[] {
  return ((request.input as any).runtimeEvidence ?? [])
    .filter((evidence: any) => evidence.result === "supports")
    .map((evidence: any) => evidence.id);
}

test("host verifier selects presentation profile, persists Runtime Evidence and can pass only with matching evidence kinds", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-profile-"));
  try {
    const artifact = fixtureArtifact(root);
    const events = new MemoryEvents();
    const transport = new CapturingTransport(request => {
      const profile = (request.input as any).verificationProfile;
      const evidenceRefs = runtimeRefs(request);
      return {
        overall: "pass",
        checkResults: profile.checks.map((check: any) => ({
          id: check.id,
          status: "pass",
          evidenceRefs
        })),
        evidenceRefs,
        gapAssessments: []
      };
    });
    const verifier = new HostArtifactVerifier({
      transport,
      events,
      reader: fakeReader(),
      evidenceCollectors: presentationEvidenceCollectors(true)
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
    assert.match(transport.requests[0].instruction, /runtimeEvidence is the authoritative evidence registry/);
    const evidenceEvents = events.events.filter(event => event.type === "evidence.collected");
    assert.equal(evidenceEvents.length, 3);
    assert.ok(evidenceEvents.some(event => (event.payload as any).kind === "presentation-render"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("host verifier fail-closes omitted required profile checks as inconclusive", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-profile-"));
  try {
    const artifact = fixtureArtifact(root);
    const events = new MemoryEvents();
    const transport = new CapturingTransport(request => {
      const evidenceRefs = runtimeRefs(request);
      return {
        overall: "pass",
        checkResults: [{ id: "presentation-structure", status: "pass", evidenceRefs }],
        evidenceRefs,
        gapAssessments: []
      };
    });
    const verifier = new HostArtifactVerifier({
      transport,
      events,
      reader: fakeReader(),
      evidenceCollectors: presentationEvidenceCollectors(true)
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

test("host verifier rejects fabricated evidence refs that were not registered by Runtime collectors", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-evidence-forge-"));
  try {
    const artifact = fixtureArtifact(root);
    const verifier = new HostArtifactVerifier({
      transport: new CapturingTransport(request => ({
        overall: "pass",
        checkResults: (request.input as any).verificationProfile.checks.map((check: any) => ({
          id: check.id,
          status: "pass",
          evidenceRefs: ["evidence:forged-by-host"]
        })),
        evidenceRefs: ["evidence:forged-by-host"],
        gapAssessments: []
      })),
      events: new MemoryEvents(),
      reader: fakeReader(),
      evidenceCollectors: presentationEvidenceCollectors(true)
    });

    await assert.rejects(
      () => verifier.verify(artifact, { state, workItem, gaps: [] }),
      /unregistered Runtime Evidence/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presentation visual check cannot pass without presentation-render Runtime Evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-verifier-render-missing-"));
  try {
    const artifact = fixtureArtifact(root);
    const transport = new CapturingTransport(request => {
      const evidenceRefs = runtimeRefs(request);
      return {
        overall: "pass",
        checkResults: (request.input as any).verificationProfile.checks.map((check: any) => ({
          id: check.id,
          status: "pass",
          evidenceRefs
        })),
        evidenceRefs,
        gapAssessments: []
      };
    });
    const verifier = new HostArtifactVerifier({
      transport,
      events: new MemoryEvents(),
      reader: fakeReader(),
      evidenceCollectors: presentationEvidenceCollectors(false)
    });

    const result = await verifier.verify(artifact, { state, workItem, gaps: [] });
    assert.equal(result.overall, "inconclusive");
    const visual = result.checkResults.find(check => check.id === "presentation-visual-quality");
    assert.equal(visual?.status, "inconclusive");
    assert.match(visual?.detail ?? "", /presentation-render/);
    assert.equal(result.checkResults.find(check => check.id === "presentation-structure")?.status, "pass");
    assert.equal(result.checkResults.find(check => check.id === "presentation-delivery-integrity")?.status, "pass");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
