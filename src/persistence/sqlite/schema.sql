PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_events (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  payload_json TEXT NOT NULL,
  causation_id TEXT,
  correlation_id TEXT,
  idempotency_key TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  UNIQUE(mission_id, sequence),
  UNIQUE(mission_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_mission_sequence ON mission_events(mission_id, sequence);
CREATE INDEX IF NOT EXISTS idx_events_mission_type_sequence ON mission_events(mission_id, type, sequence);
CREATE INDEX IF NOT EXISTS idx_events_mission_created_at ON mission_events(mission_id, created_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshot_mission_sequence ON snapshots(mission_id, event_sequence DESC);

CREATE TABLE IF NOT EXISTS mission_specs (
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, revision)
);

CREATE TABLE IF NOT EXISTS acceptance_contracts (
  mission_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, revision)
);

-- Legacy projection tables retained for compatibility. New runtime read models use
-- rm_* tables below because Mission-local ids are not globally unique.
CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  status TEXT NOT NULL,
  purpose TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  graph_revision INTEGER NOT NULL DEFAULT 0,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_work_mission_status ON work_items(mission_id, status);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  UNIQUE(work_item_id, sequence)
);

CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  backend TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_status ON executions(mission_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  logical_name TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL,
  uri TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  produced_by_attempt_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(id, version)
);
CREATE INDEX IF NOT EXISTS idx_artifacts_mission ON artifacts(mission_id, logical_name);

CREATE TABLE IF NOT EXISTS artifact_edges (
  mission_id TEXT NOT NULL,
  from_ref TEXT NOT NULL,
  to_ref TEXT NOT NULL,
  relation TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gaps (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  description TEXT NOT NULL,
  data_json TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_gaps_open ON gaps(mission_id, status, severity);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  rationale TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  status TEXT NOT NULL,
  scope TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  requested_at TEXT NOT NULL,
  decided_at TEXT
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  mission_id TEXT,
  scope TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  source_uri TEXT,
  revision TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rm_projection_checkpoints (
  projection_name TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(projection_name, mission_id)
);

CREATE TABLE IF NOT EXISTS rm_missions (
  mission_id TEXT PRIMARY KEY,
  user_goal TEXT NOT NULL DEFAULT '',
  strategy_json TEXT,
  event_sequence INTEGER NOT NULL DEFAULT 0,
  state_json TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rm_work_items (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_work_status ON rm_work_items(mission_id, status);

CREATE TABLE IF NOT EXISTS rm_attempts (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_attempt_work ON rm_attempts(mission_id, work_item_id);
CREATE INDEX IF NOT EXISTS idx_rm_attempt_work_page ON rm_attempts(mission_id, work_item_id, id);
CREATE INDEX IF NOT EXISTS idx_rm_attempt_status_page ON rm_attempts(mission_id, status, id);

CREATE TABLE IF NOT EXISTS rm_executions (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_execution_status ON rm_executions(mission_id, status);
CREATE INDEX IF NOT EXISTS idx_rm_execution_work_page ON rm_executions(mission_id, work_item_id, id);
CREATE INDEX IF NOT EXISTS idx_rm_execution_attempt_page ON rm_executions(mission_id, attempt_id, id);
CREATE INDEX IF NOT EXISTS idx_rm_execution_status_page ON rm_executions(mission_id, status, id);

CREATE TABLE IF NOT EXISTS rm_artifacts (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  logical_name TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id, version)
);
CREATE INDEX IF NOT EXISTS idx_rm_artifacts_name ON rm_artifacts(mission_id, logical_name, version);

CREATE TABLE IF NOT EXISTS rm_findings (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);

CREATE TABLE IF NOT EXISTS rm_gaps (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_gaps_status ON rm_gaps(mission_id, status, severity);

CREATE TABLE IF NOT EXISTS rm_decisions (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);

CREATE TABLE IF NOT EXISTS rm_approvals (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  status TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_approvals_status ON rm_approvals(mission_id, status);

CREATE TABLE IF NOT EXISTS rm_capability_needs (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);

CREATE TABLE IF NOT EXISTS rm_capabilities (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);

CREATE TABLE IF NOT EXISTS rm_capability_trust (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_capability_trust_capability ON rm_capability_trust(mission_id, capability_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_rm_capability_trust_page ON rm_capability_trust(mission_id);
CREATE INDEX IF NOT EXISTS idx_rm_capability_trust_capability_page ON rm_capability_trust(mission_id, capability_id);

CREATE TABLE IF NOT EXISTS rm_capability_cost (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  phase TEXT NOT NULL,
  data_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_capability_cost_capability ON rm_capability_cost(mission_id, capability_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_rm_capability_cost_page ON rm_capability_cost(mission_id);
CREATE INDEX IF NOT EXISTS idx_rm_capability_cost_capability_page ON rm_capability_cost(mission_id, capability_id);
CREATE INDEX IF NOT EXISTS idx_rm_capability_cost_phase_page ON rm_capability_cost(mission_id, phase);
CREATE INDEX IF NOT EXISTS idx_rm_capability_cost_capability_phase_page ON rm_capability_cost(mission_id, capability_id, phase);

CREATE TABLE IF NOT EXISTS rm_capability_audit (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  capability_id TEXT,
  decision TEXT NOT NULL,
  data_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_capability ON rm_capability_audit(mission_id, capability_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_decision ON rm_capability_audit(mission_id, decision, recorded_at);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_page ON rm_capability_audit(mission_id);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_capability_page ON rm_capability_audit(mission_id, capability_id);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_decision_page ON rm_capability_audit(mission_id, decision);
CREATE INDEX IF NOT EXISTS idx_rm_capability_audit_capability_decision_page ON rm_capability_audit(mission_id, capability_id, decision);

CREATE TABLE IF NOT EXISTS rm_evidence (
  mission_id TEXT NOT NULL,
  id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  collector_id TEXT NOT NULL,
  result TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, id)
);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_subject ON rm_evidence(mission_id, subject_ref, created_at, id);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_kind ON rm_evidence(mission_id, evidence_kind, created_at, id);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_page ON rm_evidence(mission_id);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_subject_page ON rm_evidence(mission_id, subject_ref);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_kind_page ON rm_evidence(mission_id, evidence_kind);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_collector_page ON rm_evidence(mission_id, collector_id);
CREATE INDEX IF NOT EXISTS idx_rm_evidence_result_page ON rm_evidence(mission_id, result);

CREATE TABLE IF NOT EXISTS rm_history_archives (
  mission_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  event_sequence INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(mission_id, object_id),
  UNIQUE(mission_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_rm_history_archives_page ON rm_history_archives(mission_id, event_sequence);

CREATE TABLE IF NOT EXISTS rm_side_effects (
  mission_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  intent_id TEXT NOT NULL,
  work_item_id TEXT,
  attempt_id TEXT,
  execution_id TEXT,
  source TEXT NOT NULL,
  effect_class TEXT NOT NULL,
  effect_type TEXT NOT NULL,
  target TEXT NOT NULL,
  status TEXT NOT NULL,
  admission_status TEXT,
  completion_status TEXT,
  intent_json TEXT NOT NULL,
  admission_json TEXT,
  replay_block_json TEXT,
  replay_block_count INTEGER NOT NULL DEFAULT 0,
  completion_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_event_sequence INTEGER NOT NULL,
  PRIMARY KEY(mission_id, operation_key)
);
CREATE INDEX IF NOT EXISTS idx_rm_side_effect_execution ON rm_side_effects(mission_id, execution_id, last_event_sequence);
CREATE INDEX IF NOT EXISTS idx_rm_side_effect_work ON rm_side_effects(mission_id, work_item_id, last_event_sequence);
CREATE INDEX IF NOT EXISTS idx_rm_side_effect_status ON rm_side_effects(mission_id, status, last_event_sequence);
