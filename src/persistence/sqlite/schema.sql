PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS missions (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mission_states (
  mission_id TEXT PRIMARY KEY,
  event_sequence INTEGER NOT NULL,
  state_json TEXT NOT NULL,
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

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  contract_revision INTEGER NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_mission_status ON requirements(mission_id, status, priority);

CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  subject_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  result TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_mission_subject ON evidence(mission_id, subject_ref);

CREATE TABLE IF NOT EXISTS verification_results (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  artifact_ref TEXT NOT NULL,
  level TEXT NOT NULL,
  overall TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verification_mission_artifact ON verification_results(mission_id, artifact_ref);

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
