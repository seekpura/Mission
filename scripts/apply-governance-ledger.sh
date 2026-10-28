#!/usr/bin/env bash
set -euo pipefail
python3 - <<'PY'
from pathlib import Path

def replace(path, old, new):
    p=Path(path); s=p.read_text()
    if new in s: return
    if old not in s: raise SystemExit(f'anchor missing in {path}: {old[:140]!r}')
    p.write_text(s.replace(old,new,1))

p=Path('src/persistence/sqlite/schema.sql'); s=p.read_text()
block='''\nCREATE TABLE IF NOT EXISTS cost_events (\n  id TEXT PRIMARY KEY,\n  mission_id TEXT NOT NULL,\n  work_item_id TEXT,\n  execution_id TEXT,\n  category TEXT NOT NULL,\n  quantity REAL NOT NULL,\n  unit TEXT NOT NULL,\n  monetary_estimate REAL,\n  data_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_cost_events_mission ON cost_events(mission_id, category, created_at);\n\nCREATE TABLE IF NOT EXISTS audit_records (\n  id TEXT PRIMARY KEY,\n  mission_id TEXT NOT NULL,\n  action TEXT NOT NULL,\n  actor_type TEXT NOT NULL,\n  target TEXT,\n  data_json TEXT NOT NULL,\n  created_at TEXT NOT NULL\n);\nCREATE INDEX IF NOT EXISTS idx_audit_records_mission ON audit_records(mission_id, created_at);\n\nCREATE TABLE IF NOT EXISTS completion_records (\n  mission_id TEXT NOT NULL,\n  mission_revision INTEGER NOT NULL,\n  data_json TEXT NOT NULL,\n  completed_at TEXT NOT NULL,\n  PRIMARY KEY(mission_id, mission_revision)\n);\n\nCREATE TABLE IF NOT EXISTS capability_trust (\n  mission_id TEXT NOT NULL,\n  capability_id TEXT NOT NULL,\n  purpose TEXT NOT NULL,\n  attempts INTEGER NOT NULL,\n  succeeded INTEGER NOT NULL,\n  failed INTEGER NOT NULL,\n  data_json TEXT NOT NULL,\n  updated_at TEXT NOT NULL,\n  PRIMARY KEY(mission_id, capability_id, purpose)\n);\n'''
if 'CREATE TABLE IF NOT EXISTS cost_events (' not in s:
    s=s.rstrip()+block
p.write_text(s.rstrip()+'\n')

replace('src/core/events/projection-store.ts',
'''import type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";''',
'''import type { SourceRecord, TruthRecord } from "../domain/knowledge.ts";\nimport type { AuditRecord, CapabilityTrustProfile, CompletionRecord, CostEvent } from "../domain/governance.ts";''')
replace('src/core/events/projection-store.ts',
'''  listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]>;''',
'''  listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]>;\n  listCostEvents(missionId: string): Promise<CostEvent[]>;\n  listAuditRecords(missionId: string): Promise<AuditRecord[]>;\n  listCapabilityTrustProfiles(missionId: string): Promise<CapabilityTrustProfile[]>;\n  listCompletionRecords(missionId: string): Promise<CompletionRecord[]>;''')

replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''import type { SourceRecord, TruthRecord } from "../../core/domain/knowledge.ts";''',
'''import type { SourceRecord, TruthRecord } from "../../core/domain/knowledge.ts";\nimport type { AuditRecord, CapabilityTrustProfile, CompletionRecord, CostEvent } from "../../core/domain/governance.ts";''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''import { SqliteKnowledgeProjector } from "./sqlite-knowledge-projector.ts";''',
'''import { SqliteKnowledgeProjector } from "./sqlite-knowledge-projector.ts";\nimport { SqliteGovernanceProjector } from "./sqlite-governance-projector.ts";''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''  private readonly knowledge: SqliteKnowledgeProjector;''',
'''  private readonly knowledge: SqliteKnowledgeProjector;\n  private readonly governance: SqliteGovernanceProjector;''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''    this.knowledge = new SqliteKnowledgeProjector(database);\n  }''',
'''    this.knowledge = new SqliteKnowledgeProjector(database);\n    this.governance = new SqliteGovernanceProjector(database);\n  }''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''    this.knowledge.apply(event);''',
'''    this.knowledge.apply(event);\n    this.governance.apply(event);''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''    db.prepare("DELETE FROM invocation_receipts WHERE mission_id = ?").run(missionId);''',
'''    db.prepare("DELETE FROM invocation_receipts WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM cost_events WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM audit_records WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM completion_records WHERE mission_id = ?").run(missionId);\n    db.prepare("DELETE FROM capability_trust WHERE mission_id = ?").run(missionId);''')
replace('src/persistence/sqlite/sqlite-projection-store.ts',
'''  async listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]> {''',
'''  async listCostEvents(missionId: string): Promise<CostEvent[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM cost_events WHERE mission_id = ? ORDER BY created_at ASC").all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as CostEvent);\n  }\n\n  async listAuditRecords(missionId: string): Promise<AuditRecord[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM audit_records WHERE mission_id = ? ORDER BY created_at ASC").all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as AuditRecord);\n  }\n\n  async listCapabilityTrustProfiles(missionId: string): Promise<CapabilityTrustProfile[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM capability_trust WHERE mission_id = ? ORDER BY capability_id, purpose").all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as CapabilityTrustProfile);\n  }\n\n  async listCompletionRecords(missionId: string): Promise<CompletionRecord[]> {\n    const rows = this.database.db.prepare("SELECT data_json FROM completion_records WHERE mission_id = ? ORDER BY mission_revision ASC").all(missionId) as Array<{ data_json: string }>;\n    return rows.map(row => JSON.parse(row.data_json) as CompletionRecord);\n  }\n\n  async listInvocationReceipts(missionId: string): Promise<InvocationReceipt[]> {''')
PY
