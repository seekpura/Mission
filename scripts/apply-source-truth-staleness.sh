#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new, count=1):
    p=Path(path); s=p.read_text()
    if new in s:
        return
    if old not in s:
        raise SystemExit(f'anchor not found in {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,count))

# Event types
replace('src/core/domain/event.ts',
'''  | "truth.added"\n  | "truth.superseded"\n  | "environment.snapshot.created"''',
'''  | "source.registered"\n  | "source.status.changed"\n  | "truth.added"\n  | "truth.status.changed"\n  | "truth.superseded"\n  | "evidence.invalidated"\n  | "environment.snapshot.created"''')

# Evidence validity
replace('src/core/domain/verification.ts',
'''  sourceRef?: string;\n  producedBy?: string;\n  createdAt: string;''',
'''  sourceRef?: string;\n  producedBy?: string;\n  validity?: "active" | "stale" | "invalid";\n  createdAt: string;''')

# Acceptance ignores stale/invalid evidence
replace('src/core/acceptance/acceptance-evaluator.ts',
'''    const supportingEvidence = new Set(input.evidence.filter(e => e.result === "supports").map(e => e.id));''',
'''    const supportingEvidence = new Set(input.evidence\n      .filter(e => e.result === "supports" && (e.validity ?? "active") === "active")\n      .map(e => e.id));''')

# Projection interface
replace('src/core/events/projection-store.ts',
'''import type { InvocationReceipt } from "../domain/invocation.ts";''',
'''import type { InvocationReceipt } from "../domain/invocation.ts";\nimport type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";''')
replace('src/core/events/projection-store.ts',
'''  listEvidence(missionId: string): Promise<Evidence[]>;\n  listArtifacts(missionId: string): Promise<Artifact[]>;''',
'''  listEvidence(missionId: string): Promise<Evidence[]>;\n  listSources(missionId: string): Promise<SourceRecord[]>;\n  listTruths(missionId: string): Promise<TruthRecord[]>;\n  listArtifacts(missionId: string): Promise<Artifact[]>;''')

# SQLite schema
p=Path('src/persistence/sqlite/schema.sql'); s=p.read_text()
block='''\nCREATE TABLE IF NOT EXISTS sources (\n  id TEXT PRIMARY KEY,\n  mission_id TEXT NOT NULL,\n  status TEXT NOT NULL,\n  uri TEXT,\n  data_json TEXT NOT NULL,\n  captured_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_sources_mission_status ON sources(mission_id, status);\n\nCREATE TABLE IF NOT EXISTS truths (\n  id TEXT PRIMARY KEY,\n  mission_id TEXT NOT NULL,\n  truth_key TEXT NOT NULL,\n  status TEXT NOT NULL,\n  data_json TEXT NOT NULL,\n  created_at TEXT NOT NULL,\n  updated_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_truths_mission_key_status ON truths(mission_id, truth_key, status);\n'''
if 'CREATE TABLE IF NOT EXISTS sources (' not in s:
    marker='CREATE TABLE IF NOT EXISTS verification_results ('
    s=s.replace(marker, block+'\n'+marker,1)
    p.write_text(s)

# Projection store imports / projector / rebuild / reads
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''import type { InvocationReceipt } from "../../core/domain/invocation.ts";''',
'''import type { InvocationReceipt } from "../../core/domain/invocation.ts";\nimport type { SourceRecord, TruthRecord } from "../../core/domain/knowledge.ts";''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''import { SqliteAssuranceProjector } from "./sqlite-assurance-projector.ts";''',
'''import { SqliteAssuranceProjector } from "./sqlite-assurance-projector.ts";\nimport { SqliteKnowledgeProjector } from "./sqlite-knowledge-projector.ts";''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''  private readonly assurance: SqliteAssuranceProjector;\n  constructor(database: MissionDatabase) {\n    this.database = database;\n    this.entities = new SqliteEntityProjector(database);\n    this.assurance = new SqliteAssuranceProjector(database);\n  }''',
'''  private readonly assurance: SqliteAssuranceProjector;\n  private readonly knowledge: SqliteKnowledgeProjector;\n  constructor(database: MissionDatabase) {\n    this.database = database;\n    this.entities = new SqliteEntityProjector(database);\n    this.assurance = new SqliteAssuranceProjector(database);\n    this.knowledge = new SqliteKnowledgeProjector(database);\n  }''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''    this.entities.apply(event);\n    this.assurance.apply(event);''',
'''    this.entities.apply(event);\n    this.assurance.apply(event);\n    this.knowledge.apply(event);''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''    db.prepare("DELETE FROM evidence WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM verification_results WHERE mission_id = ?").run(missionId);''',
'''    db.prepare("DELETE FROM evidence WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM sources WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM truths WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM verification_results WHERE mission_id = ?").run(missionId);''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''  async listArtifacts(missionId: string): Promise<Artifact[]> {''',
'''  async listSources(missionId: string): Promise<SourceRecord[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM sources WHERE mission_id = ? ORDER BY captured_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as SourceRecord);\n  }\n\n  async listTruths(missionId: string): Promise<TruthRecord[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM truths WHERE mission_id = ? ORDER BY created_at ASC")\n      .all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as TruthRecord);\n  }\n\n  async listArtifacts(missionId: string): Promise<Artifact[]> {''')

# MissionReadModel knowledge reads
replace('src/core/mission/mission-read-model.ts',
'''import type { InvocationReceipt } from "../domain/invocation.ts";''',
'''import type { InvocationReceipt } from "../domain/invocation.ts";\nimport type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";''')
replace('src/core/mission/mission-read-model.ts',
'''  async artifacts(missionId: string): Promise<Artifact[]> {''',
'''  async sources(missionId: string): Promise<SourceRecord[]> {\n    if (this.projections) return this.projections.listSources(missionId);\n    const map = new Map<string, SourceRecord>();\n    for (const event of await this.store.list(missionId)) {\n      const payload = event.payload as any;\n      if (event.type === "source.registered") { const source = (payload.source ?? payload) as SourceRecord; map.set(source.id, { ...source }); }\n      if (event.type === "source.status.changed" && map.has(payload.id)) map.get(payload.id)!.status = payload.status;\n    }\n    return [...map.values()];\n  }\n\n  async truths(missionId: string): Promise<TruthRecord[]> {\n    if (this.projections) return this.projections.listTruths(missionId);\n    const map = new Map<string, TruthRecord>();\n    for (const event of await this.store.list(missionId)) {\n      const payload = event.payload as any;\n      if (event.type === "truth.added") { const truth = (payload.truth ?? payload) as TruthRecord; map.set(truth.id, { ...truth }); }\n      if (event.type === "truth.status.changed" && map.has(payload.id)) map.get(payload.id)!.status = payload.status;\n      if (event.type === "truth.superseded" && map.has(payload.id ?? payload.truthId)) map.get(payload.id ?? payload.truthId)!.status = "superseded";\n    }\n    return [...map.values()];\n  }\n\n  async artifacts(missionId: string): Promise<Artifact[]> {''')

# Worker protocol types and parsing
replace('src/core/execution/worker-output.ts',
'''export interface WorkerOutputEnvelope {\n  status: "completed" | "partial" | "failed";\n  summary: string;\n  outputs: WorkerOutputFile[];\n  proposedFacts: Array<{ key: string; value: unknown; confidence?: number }>;''',
'''export interface WorkerSourceProposal {\n  id?: string;\n  type?: "web" | "file" | "github" | "document" | "api" | "user" | "other";\n  uri?: string;\n  localRef?: string;\n  title?: string;\n  capturedAt?: string;\n  version?: string;\n  commit?: string;\n  authority?: string;\n  freshUntil?: string;\n  contentHash?: string;\n  metadata?: Record<string, unknown>;\n}\n\nexport interface WorkerProposedFact {\n  key: string;\n  value: unknown;\n  confidence?: number;\n  sourceRefs?: string[];\n  requirementRefs?: string[];\n}\n\nexport interface WorkerOutputEnvelope {\n  status: "completed" | "partial" | "failed";\n  summary: string;\n  outputs: WorkerOutputFile[];\n  sources?: WorkerSourceProposal[];\n  proposedFacts: WorkerProposedFact[];''')
replace('src/core/execution/worker-output.ts',
'''  "outputs":[{"path":"relative/path.ext","logicalName":"stable-artifact-name","type":"file|document|presentation|image|video|audio|code|website|dataset|research|other","requirementRefs":["R1"]}],\n  "proposedFacts":[],''',
'''  "outputs":[{"path":"relative/path.ext","logicalName":"stable-artifact-name","type":"file|document|presentation|image|video|audio|code|website|dataset|research|other","requirementRefs":["R1"]}],\n  "sources":[{"id":"source-id","type":"web|file|github|document|api|user|other","uri":"https://...","capturedAt":"ISO-8601","freshUntil":"ISO-8601"}],\n  "proposedFacts":[{"key":"stable.fact.key","value":"...","sourceRefs":["source-id"],"requirementRefs":["R1"]}],''')
replace('src/core/execution/worker-output.ts',
'''    outputs,\n    proposedFacts: Array.isArray(parsed.proposedFacts) ? parsed.proposedFacts.filter((x: unknown) => !!x && typeof x === "object") : [],''',
'''    outputs,\n    sources: Array.isArray(parsed.sources) ? parsed.sources.filter((x: unknown) => !!x && typeof x === "object") : [],\n    proposedFacts: Array.isArray(parsed.proposedFacts) ? parsed.proposedFacts.filter((x: unknown) => !!x && typeof x === "object") : [],''')

# Runtime wiring + orchestrator ingestion
replace('src/runtime/mission-runtime.ts',
'''import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";''',
'''import type { SecureAcquisitionService } from "../core/capabilities/secure-acquisition-service.ts";\nimport { KnowledgeStalenessManager } from "../core/knowledge/knowledge-staleness-manager.ts";\nimport { WorkerKnowledgeIngestor } from "../core/knowledge/worker-knowledge-ingestor.ts";''')
replace('src/runtime/mission-runtime.ts',
'''  readonly inspection?: ArtifactInspectionService;''',
'''  readonly inspection?: ArtifactInspectionService;\n  readonly knowledge: KnowledgeStalenessManager;''')
replace('src/runtime/mission-runtime.ts',
'''    this.artifacts = new FileArtifactStore(rootDir);\n    if (options.host) {''',
'''    this.artifacts = new FileArtifactStore(rootDir);\n    this.knowledge = new KnowledgeStalenessManager({ controller: this.controller, projections: this.projections });\n    if (options.host) {''')
replace('src/runtime/mission-runtime.ts',
'''        executionRouter,\n        options: { maxConcurrency: options.maxConcurrency }''',
'''        executionRouter,\n        knowledgeIngestor: new WorkerKnowledgeIngestor({ knowledge: this.knowledge, projections: this.projections }),\n        options: { maxConcurrency: options.maxConcurrency }''')

replace('src/runtime/orchestration/mission-orchestrator.ts',
'''import { writeExecutionRecoveryManifest } from "../recovery/recovery-manifest.ts";''',
'''import { writeExecutionRecoveryManifest } from "../recovery/recovery-manifest.ts";\nimport type { WorkerKnowledgeIngestor } from "../../core/knowledge/worker-knowledge-ingestor.ts";''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''  private readonly executionRouter?: WorkExecutionRouter;\n  private readonly running''',
'''  private readonly executionRouter?: WorkExecutionRouter;\n  private readonly knowledgeIngestor?: WorkerKnowledgeIngestor;\n  private readonly running''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    executionRouter?: WorkExecutionRouter;\n    assurance?: ArtifactAssurancePipeline;''',
'''    executionRouter?: WorkExecutionRouter;\n    knowledgeIngestor?: WorkerKnowledgeIngestor;\n    assurance?: ArtifactAssurancePipeline;''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''    this.executionRouter = input.executionRouter;\n    this.assurance =''',
'''    this.executionRouter = input.executionRouter;\n    this.knowledgeIngestor = input.knowledgeIngestor;\n    this.assurance =''')
replace('src/runtime/orchestration/mission-orchestrator.ts',
'''      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: envelope?.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs },''',
'''      await this.knowledgeIngestor?.ingest({ work, attemptId, envelope, artifactRefs: outcome.artifactRefs });\n      await this.controller.emit(work.missionId, "attempt.completed", { id: attemptId, workItemId: work.id, status: envelope?.status === "partial" ? "partial" : "succeeded", artifactRefs: outcome.artifactRefs },''')
PY
