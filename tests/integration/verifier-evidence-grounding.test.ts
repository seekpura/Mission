import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Artifact } from "../../src/core/domain/artifact.ts";
import type { MissionEvent } from "../../src/core/domain/event.ts";
import type { MissionState } from "../../src/core/domain/mission.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { Gap } from "../../src/core/domain/verification.ts";
import type { EventStore } from "../../src/core/events/event-store.ts";
import {
  VerificationEvidenceCollectorRegistry,
  type VerificationEvidenceCollector
} from "../../src/core/verification/evidence-collector.ts";
import { HostArtifactVerifier } from "../../src/runtime/host-artifact-verifier.ts";
import type { HostJsonRequest, HostJsonTransport } from "../../src/runtime/host-agent-json-transport.ts";

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

class CallbackTransport implements HostJsonTransport {
  private readonly callback: (request: HostJsonRequest) => unknown;
  constructor(callback: (request: HostJsonRequest) => unknown) {
    this.callback = callback;
  }
  async request(input: HostJsonRequest): Promise<unknown> { return this.callback(input); }
}

function reader(userGoal = "verify evidence grounding") {
  return {
    async state() { throw new Error("not used"); },
    async journal() { return { userGoal } as any; },
    async latestStrategy() { return undefined; }
  };
}

function state(missionId: string): MissionState {
  return {
    missionId,
    status: "active",
    revision: 1,
    missionSpecRevision: 1,
    acceptanceRevision: 1,
    strategyRevision: 1,
    graphRevision: 1,
    environmentSnapshotRevision: 0,
    activeWorkstreamIds: [],
    activeWorkItemIds: ["work-1"],
    readyWorkItemIds: [],
    blockedWorkItemIds: [],
    verifyingWorkItemIds: ["work-1"],
    openGapIds: [],
    blockingGapIds: [],
    activeExecutionIds: [],
    pendingApprovalIds: [],
    finalArtifactRefs: [],
    lastEventSequence: 1
  };
}

function work(missionId: string, type: Artifact["type"]): WorkItem {
  return {
    id: "work-1",
    missionId,
    purpose: "production",
    objective: "produce a grounded deliverable",
    status: "verifying",
    requirementRefs: ["req-1"],
    gapRefs: [],
    inputArtifactRefs: [],
    expectedOutputs: [{ logicalName: "deliverable", type, required: true }],
    localAcceptanceCriteria: [{ id: "criterion-1", description: "deliverable is grounded", priority: "required" }],
    capabilityNeedRefs: [],
    priority: 1,
    graphRevision: 1,
    createdBy: "planner",
    createdAt: "2026-10-29T00:00:00.000Z",
    updatedAt: "2026-10-29T00:00:00.000Z"
  };
}

function artifact(root: string, missionId: string, type: Artifact["type"], extension: string): Artifact {
  const path = join(root, `deliverable${extension}`);
  const content = "fixture content";
  writeFileSync(path, content, "utf8");
  return {
    id: "artifact-1",
    missionId,
    logicalName: "deliverable",
    type,
    version: 1,
    status: "candidate",
    uri: path,
    contentHash: `sha256:${createHash("sha256").update(content).digest("hex")}`,
    sizeBytes: Buffer.byteLength(content),
    producedByAttemptId: "attempt-1",
    sourceArtifactRefs: [],
    createdAt: "2026-10-29T00:00:00.000Z"
  };
}

test("unsupported negative verifier judgment is downgraded from fail to inconclusive", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-grounded-fail-"));
  const missionId = "mission-grounded-fail";
  try {
    const value = artifact(root, missionId, "presentation", ".pptx");
    const collector: VerificationEvidenceCollector = {
      id: "package-only",
      kinds: ["file-integrity", "presentation-package"],
      supports: () => true,
      collect: () => [
        { type: "file-validation", kind: "file-integrity", claim: "file bytes valid", result: "supports" },
        { type: "source", kind: "presentation-package", claim: "package structure inspected", result: "supports" }
      ]
    };
    const verifier = new HostArtifactVerifier({
      events: new MemoryEvents(),
      reader: reader(),
      evidenceCollectors: new VerificationEvidenceCollectorRegistry([collector]),
      transport: new CallbackTransport(request => {
        const input = request.input as any;
        const refs = input.runtimeEvidence.map((item: any) => item.id);
        return {
          overall: "fail",
          checkResults: input.verificationProfile.checks.map((check: any) => ({
            id: check.id,
            status: check.id === "presentation-visual-quality" ? "fail" : "pass",
            evidenceRefs: refs
          })),
          evidenceRefs: refs,
          gapAssessments: []
        };
      })
    });

    const result = await verifier.verify(value, { state: state(missionId), workItem: work(missionId, "presentation"), gaps: [] });
    assert.equal(result.overall, "inconclusive");
    const visual = result.checkResults.find(check => check.id === "presentation-visual-quality");
    assert.equal(visual?.status, "inconclusive");
    assert.match(visual?.detail ?? "", /presentation-render/);
    assert.equal(result.checkResults.some(check => check.status === "fail"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("gap resolution citing only inconclusive Runtime Evidence is downgraded and cannot close the gap", async () => {
  const root = mkdtempSync(join(tmpdir(), "mission-grounded-gap-"));
  const missionId = "mission-grounded-gap";
  try {
    const value = artifact(root, missionId, "file", ".txt");
    const gap: Gap = {
      id: "gap-1",
      missionId,
      category: "evidence",
      severity: "major",
      description: "prove the uncertain claim",
      findingRefs: [],
      requirementRefs: ["req-1"],
      artifactRefs: ["artifact-1@1"],
      status: "open",
      openedAt: "2026-10-29T00:00:00.000Z"
    };
    const collector: VerificationEvidenceCollector = {
      id: "mixed-evidence",
      kinds: ["file-integrity", "text-content"],
      supports: () => true,
      collect: () => [
        { type: "file-validation", kind: "file-integrity", claim: "file bytes valid", result: "supports" },
        { type: "source", kind: "text-content", claim: "claim remains uncertain", result: "inconclusive" }
      ]
    };
    const verifier = new HostArtifactVerifier({
      events: new MemoryEvents(),
      reader: reader(),
      evidenceCollectors: new VerificationEvidenceCollectorRegistry([collector]),
      transport: new CallbackTransport(request => {
        const input = request.input as any;
        const supporting = input.runtimeEvidence.find((item: any) => item.result === "supports").id;
        const inconclusive = input.runtimeEvidence.find((item: any) => item.result === "inconclusive").id;
        return {
          overall: "pass",
          checkResults: input.verificationProfile.checks.map((check: any) => ({
            id: check.id,
            status: "pass",
            evidenceRefs: [supporting]
          })),
          evidenceRefs: [supporting, inconclusive],
          gapAssessments: [{
            gapId: "gap-1",
            status: "resolved",
            evidenceRefs: [inconclusive],
            confidence: 0.95,
            detail: "producer believes this is resolved"
          }]
        };
      })
    });

    const item = work(missionId, "file");
    item.gapRefs = [gap.id];
    const result = await verifier.verify(value, { state: state(missionId), workItem: item, gaps: [gap] });
    assert.equal(result.overall, "pass");
    assert.equal(result.gapAssessments?.[0]?.status, "inconclusive");
    assert.ok((result.gapAssessments?.[0]?.confidence ?? 1) <= 0.5);
    assert.match(result.gapAssessments?.[0]?.detail ?? "", /none of the cited Runtime Evidence has result=supports/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
