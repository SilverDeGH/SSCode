/** SQLite 建表语句与迁移（P2-06：版本化迁移）。node:sqlite，无外部依赖。 */

export const SCHEMA_VERSION = 2;

export const MIGRATIONS: Record<number, string> = {
  2: `ALTER TABLE tasks ADD COLUMN approval_mode TEXT NOT NULL DEFAULT 'manual';`,
  1: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  is_git INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  state TEXT NOT NULL,
  input TEXT NOT NULL,
  summary TEXT,
  model_config_id TEXT,
  client_request_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  ended_at INTEGER
);
CREATE UNIQUE INDEX idx_tasks_dedup ON tasks(project_id, client_request_id);
CREATE INDEX idx_tasks_project_state ON tasks(project_id, state, seq);

CREATE TABLE tool_calls (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,          -- JSON，已脱敏
  state TEXT NOT NULL,
  result TEXT,
  approval_id TEXT,
  created_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_tool_calls_task ON tool_calls(task_id, seq);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  tool_call_id TEXT NOT NULL REFERENCES tool_calls(id),
  operation TEXT NOT NULL,
  params TEXT NOT NULL,        -- JSON
  reason TEXT NOT NULL,
  risk_summary TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  decided_at INTEGER,
  note TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_approvals_task ON approvals(task_id, state);

CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT,
  task_id TEXT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,       -- JSON
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_cursor ON events(id);
CREATE INDEX idx_events_project ON events(project_id, id);

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  created_at INTEGER NOT NULL,
  undone_at INTEGER
);
CREATE UNIQUE INDEX idx_snapshots_task ON snapshots(task_id);

CREATE TABLE snapshot_files (
  id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL REFERENCES snapshots(id),
  path TEXT NOT NULL,
  change_kind TEXT NOT NULL,
  existed_before INTEGER NOT NULL,
  before_hash TEXT,
  after_hash TEXT,
  backup_path TEXT,
  UNIQUE(snapshot_id, path)
);

CREATE TABLE model_configs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  api_key_ref TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE idempotency_keys (
  key TEXT PRIMARY KEY,        -- scope:clientKey
  response TEXT NOT NULL,      -- JSON，首次请求的响应快照
  created_at INTEGER NOT NULL
);

CREATE TABLE kv_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
};
