import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { MissionDatabase } from "../../src/persistence/sqlite/database.ts";
import { SqliteProjectionStore } from "../../src/persistence/sqlite/sqlite-projection-store.ts";
import { SqliteEventStore } from "../../src/persistence/sqlite/sqlite-event-store.ts";
import { MissionController } from "../../src/core/mission/controller.ts";
import { KnowledgeStalenessManager } from "../../src/core/knowledge/knowledge-staleness-manager.ts";
import { WorkerKnowledgeIngestor } from "../../src/core/knowledge/worker-knowledge-ingestor.ts";
import type { WorkItem } from "../../src/core/domain/work-item.ts";
import type { WorkerOutputEnvelope } from "../../src/core/execution/worker-output.ts";

function setup() {
  const db = new MissionDatabase(":memory:");
  db.migrate(join(process.cwd(), "src", "persistence", "sqlite", "schema.sql"));
  const projections = new SqliteProjectionStore(db);
  const events = new SqliteEventStore(db, projections);
  const controller = new MissionController(events, { projections });
  const knowledge = new KnowledgeStalenessManager({ controller, projections });
  return { db, projections, events, controller, knowledge };
}

test("stale source invalidates only dependent truth, evidence, artifact and requirement and reopens completed mission", async () => {
  const { db, projections, events, controller, knowledge } = setup();
  const missionId = "m-stale";
  const now = new Date().toISOString();
  await controller.createMission(missionId, "publish benchmark report");
  await controller.emit(missionId, "acceptance.revised", { revision: 2, contract: {
    missionId, revision: 2, createdAt: now,
    requirements: [
      { id: "r-benchmark", description: "current benchmark", type: "evidence", priority: "critical", verification: "evidence", status: "unverified", evidenceRefs: [] },
      { id: "r-method", description: "method appendix", type: "content", priority: "required", verification: "artifact", status: "unverified", evidenceRefs: [] }
    ], requiredArtifacts: [], requiredValidations: [], criticalFailureConditions: []
  } }, { type: "controller" });

  await knowledge.registerSource({ id: "s-bench", missionId, type: "web", uri: "https://example.test/bench", capturedAt: now, status: "active", metadata: {} });
  await knowledge.registerSource({ id: "s-method", missionId, type: "document", uri: "file:///method.pdf", capturedAt: now, status: "active", metadata: {} });
  await knowledge.recordTruth({ id: "t-bench", missionId, key: "benchmark.score", value: 91, source: "source", sourceRefs: ["s-bench"], confidence: "verified", status: "active", requirementRefs: ["r-benchmark"], artifactRefs: ["report@1"], createdAt: now });
  await knowledge.recordTruth({ id: "t-method", missionId, key: "method.version", value: "v2", source: "source", sourceRefs: ["s-method"], confidence: "verified", status: "active", requirementRefs: ["r-method"], artifactRefs: ["appendix@1"], createdAt: now });

  await controller.recordArtifact(missionId, { id: "report", missionId, logicalName: "report", type: "document", version: 1, status: "verified", uri: "/tmp/report.pdf", contentHash: "report-hash", producedByAttemptId: "a1", sourceArtifactRefs: [], createdAt: now });
  await controller.recordArtifact(missionId, { id: "appendix", missionId, logicalName: "appendix", type: "document", version: 1, status: "verified", uri: "/tmp/appendix.pdf", contentHash: "appendix-hash", producedByAttemptId: "a2", sourceArtifactRefs: [], createdAt: now });
  await controller.validateArtifact(missionId, "report@1", true);
  await controller.validateArtifact(missionId, "appendix@1", true);
  await controller.recordEvidence(missionId, { id: "ev-bench", missionId, subjectRef: "r-benchmark", type: "source", claim: "benchmark supported", result: "supports", sourceRef: "t-bench", validity: "active", createdAt: now });
  await controller.recordEvidence(missionId, { id: "ev-method", missionId, subjectRef: "r-method", type: "source", claim: "method supported", result: "supports", sourceRef: "t-method", validity: "active", createdAt: now });
  await controller.setRequirementStatus(missionId, "r-benchmark", "satisfied", ["ev-bench"]);
  await controller.setRequirementStatus(missionId, "r-method", "satisfied", ["ev-method"]);
  await controller.emit(missionId, "mission.completed", { reason: "fixture completed" }, { type: "controller" });

  const result = await knowledge.markSourceStatus(missionId, "s-bench", "stale", "new benchmark release detected");
  assert.equal(result.gapId, "stale-source:s-bench");
  assert.deepEqual(result.truthRefs, ["t-bench"]);
  assert.deepEqual(result.artifactRefs, ["report@1"]);
  assert.deepEqual(result.requirementRefs, ["r-benchmark"]);

  const sources = await projections.listSources(missionId);
  assert.equal(sources.find(item => item.id === "s-bench")?.status, "stale");
  assert.equal(sources.find(item => item.id === "s-method")?.status, "active");
  const truths = await projections.listTruths(missionId);
  assert.equal(truths.find(item => item.id === "t-bench")?.status, "stale");
  assert.equal(truths.find(item => item.id === "t-method")?.status, "active");
  const evidence = await projections.listEvidence(missionId);
  assert.equal(evidence.find(item => item.id === "ev-bench")?.validity, "invalid");
  assert.equal(evidence.find(item => item.id === "ev-method")?.validity ?? "active", "active");
  const requirements = await projections.listRequirements(missionId);
  assert.equal(requirements.find(item => item.id === "r-benchmark")?.status, "unverified");
  assert.equal(requirements.find(item => item.id === "r-method")?.status, "satisfied");
  const artifacts = await projections.listArtifacts(missionId);
  assert.equal(artifacts.find(item => item.id === "report")?.status, "invalid");
  assert.equal(artifacts.find(item => item.id === "appendix")?.status, "final");
  assert.equal((await controller.state(missionId)).status, "reopened");
  assert.equal((await projections.listGaps(missionId)).filter(gap => gap.id === "stale-source:s-bench" && gap.status === "open").length, 1);

  projections.rebuild(missionId, await events.list(missionId));
  assert.equal((await projections.listSources(missionId)).find(item => item.id === "s-bench")?.status, "stale");
  assert.equal((await projections.listTruths(missionId)).find(item => item.id === "t-bench")?.status, "stale");
  assert.equal((await projections.listEvidence(missionId)).find(item => item.id === "ev-bench")?.validity, "invalid");
  db.close();
});

test("worker knowledge ingestion verifies sourced facts but keeps unsourced facts assumed", async () => {
  const { db, projections, controller, knowledge } = setup();
  const missionId = "m-ingest";
  await controller.createMission(missionId, "research current facts");
  const ingestor = new WorkerKnowledgeIngestor({ knowledge, projections });
  const now = new Date().toISOString();
  const work: WorkItem = {
    id: "w1", missionId, purpose: "production", objective: "research", status: "running", requirementRefs: ["r1"], gapRefs: [], inputArtifactRefs: [], expectedOutputs: [], localAcceptanceCriteria: [], capabilityNeedRefs: [], priority: 50, graphRevision: 1, createdBy: "planner", createdAt: now, updatedAt: now
  };
  const envelope: WorkerOutputEnvelope = {
    status: "completed", summary: "researched", outputs: [],
    sources: [{ id: "source-official", type: "web", uri: "https://example.test/official", capturedAt: now, freshUntil: new Date(Date.now() + 86400000).toISOString(), authority: "official" }],
    proposedFacts: [
      { key: "fact.sourced", value: 42, sourceRefs: ["source-official"], requirementRefs: ["r1"] },
      { key: "fact.unsourced", value: "guess", requirementRefs: ["r1"] }
    ], proposedWork: [], warnings: []
  };
  const result = await ingestor.ingest({ work, attemptId: "attempt-1", envelope, artifactRefs: ["report@1"] });
  assert.deepEqual(result.sourceRefs, ["source-official"]);
  assert.equal(result.truthRefs.length, 2);
  const truths = await projections.listTruths(missionId);
  assert.equal(truths.find(item => item.key === "fact.sourced")?.confidence, "verified");
  assert.equal(truths.find(item => item.key === "fact.sourced")?.source, "source");
  assert.equal(truths.find(item => item.key === "fact.unsourced")?.confidence, "assumed");
  assert.equal(truths.find(item => item.key === "fact.unsourced")?.source, "inference");
  assert.deepEqual(truths.find(item => item.key === "fact.sourced")?.artifactRefs, ["report@1"]);
  db.close();
});
