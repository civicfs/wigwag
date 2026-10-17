const appendOnly = (t: string) => `
CREATE TRIGGER ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;
CREATE TRIGGER ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT, '${t} is append-only'); END;`;

export const SCHEMA_V1 = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  agent_session_id TEXT,
  cwd TEXT NOT NULL,
  workspace TEXT NOT NULL,
  pid_chain TEXT NOT NULL,
  mcp_ppid INTEGER,
  state TEXT NOT NULL CHECK (state IN ('online-busy', 'online-idle', 'offline')),
  transport TEXT NOT NULL CHECK (transport IN ('claude-channel', 'codex-queue')),
  spawned_by TEXT,
  launch_json TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX sessions_name ON sessions (name);
CREATE INDEX sessions_agent_session ON sessions (agent_session_id);

CREATE TABLE name_claims (
  name TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  claimed_at TEXT NOT NULL,
  released_at TEXT
);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  from_name TEXT NOT NULL,
  from_workspace TEXT,
  to_target TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('message', 'request', 'response', 'notice')),
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  attachments TEXT NOT NULL,
  reply_to TEXT,
  request_id TEXT,
  expires_at TEXT,
  stream TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_request ON messages (request_id, kind);
${appendOnly('messages')}

CREATE TABLE deliveries (
  message_id TEXT NOT NULL REFERENCES messages (id),
  recipient TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'pushed', 'failed', 'stuck', 'read')),
  hold_reason TEXT CHECK (hold_reason IN ('offline', 'unbound', 'low', 'muted', 'throttled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  transport TEXT,
  next_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient)
);
CREATE INDEX deliveries_recipient_state ON deliveries (recipient, state);
CREATE INDEX deliveries_state ON deliveries (state);

CREATE TABLE delivery_events (
  message_id TEXT NOT NULL,
  recipient TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  detail TEXT,
  at TEXT NOT NULL
);
${appendOnly('delivery_events')}

CREATE TABLE blobs (
  ref TEXT PRIMARY KEY,
  size INTEGER NOT NULL,
  media_type TEXT NOT NULL,
  name TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
${appendOnly('blobs')}
CREATE TABLE blob_scopes (
  ref TEXT NOT NULL REFERENCES blobs (ref),
  workspace TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (ref, workspace)
);
${appendOnly('blob_scopes')}

CREATE TABLE kv (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value_json TEXT,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace, key)
);
CREATE INDEX kv_key ON kv (key);
CREATE TABLE kv_history (
  workspace TEXT NOT NULL,
  key TEXT NOT NULL,
  version INTEGER NOT NULL,
  value_json TEXT,
  updated_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, key, version)
);
${appendOnly('kv_history')}

CREATE TABLE streams (
  workspace TEXT NOT NULL,
  name TEXT NOT NULL,
  json_schema TEXT,
  description TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace, name)
);
CREATE INDEX streams_name ON streams (name);
${appendOnly('streams')}
CREATE TABLE stream_records (
  workspace TEXT NOT NULL,
  stream TEXT NOT NULL,
  seq INTEGER NOT NULL,
  record_json TEXT NOT NULL,
  appended_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (workspace, stream, seq),
  FOREIGN KEY (workspace, stream) REFERENCES streams (workspace, name)
);
${appendOnly('stream_records')}

CREATE TABLE subscriptions (
  session_name TEXT NOT NULL,
  target TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
  filter_json TEXT,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE TABLE mutes (
  session_name TEXT NOT NULL,
  target TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE TABLE throttles (
  from_name TEXT NOT NULL,
  to_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);

-- Spec §17: undirected links between workspaces, a < b. Active while removed_at IS NULL.
CREATE TABLE workspace_links (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  created_at TEXT NOT NULL,
  removed_at TEXT,
  CHECK (a < b)
);
CREATE UNIQUE INDEX workspace_links_active ON workspace_links (a, b) WHERE removed_at IS NULL;
CREATE TABLE workspace_link_events (
  a TEXT NOT NULL,
  b TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('link', 'unlink')),
  at TEXT NOT NULL
);
${appendOnly('workspace_link_events')}
`;

export const SCHEMA_V2 = `
CREATE TABLE question_integrations (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id),
  native_session_id TEXT NOT NULL,
  ready_at TEXT NOT NULL
);
CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  orchestrator_session_id TEXT NOT NULL REFERENCES sessions(id),
  orchestrator_native_id TEXT NOT NULL,
  worker_session_id TEXT NOT NULL REFERENCES sessions(id),
  worker_native_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  task_message_id TEXT NOT NULL REFERENCES messages(id),
  created_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE(orchestrator_session_id, idempotency_key)
);
CREATE UNIQUE INDEX assignment_worker_active ON assignments(worker_session_id) WHERE ended_at IS NULL;
CREATE TABLE question_relays (
  id TEXT PRIMARY KEY,
  assignment_id TEXT NOT NULL REFERENCES assignments(id),
  native_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('claude','codex','codex_async')),
  questions_json TEXT NOT NULL,
  answers_json TEXT,
  message_id TEXT NOT NULL REFERENCES messages(id),
  state TEXT NOT NULL CHECK(state IN ('pending','answered','applied','cancelled','failed')),
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(assignment_id, native_session_id, tool_use_id)
);
`;

/**
 * 0.3.0 W2/W7. name_source: where the current name came from (a custom name wins over native adoption). native_ref:
 * the Claude transcript path the trusted hook reported. conn_generation: bumped whenever a connection takes the slot,
 * so a stale connection's disconnect cannot mark it offline. retired_*: a slot handed over to its canonical slot
 * (retired_into) or retired by the owner (retired_into NULL). Existing named rows that do not have the provisional
 * shape <agent>-<slug>-<4 base32> are treated as custom.
 * W8: link (MCP connection up or down, meaningful while state <> 'offline'), parent_state (the agent process or
 * thread), agent_pid/agent_start (the Claude parent's process identity, src/proc/identity.ts), parent_checked_at.
 * Existing rows get link 'connected' and parent_state 'unknown'; the broker-start verification (Task 10) resolves them.
 * deliveries is rebuilt (SQLite cannot alter a CHECK) so hold_reason accepts 'disconnected'; rows are copied as is.
 */
export const SCHEMA_V3 = `
ALTER TABLE sessions ADD COLUMN name_source TEXT NOT NULL DEFAULT 'provisional'
  CHECK (name_source IN ('provisional', 'native', 'custom'));
ALTER TABLE sessions ADD COLUMN native_name TEXT;
ALTER TABLE sessions ADD COLUMN native_ref TEXT;
ALTER TABLE sessions ADD COLUMN conn_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN retired_at TEXT;
ALTER TABLE sessions ADD COLUMN retired_into TEXT REFERENCES sessions (id);
ALTER TABLE sessions ADD COLUMN link TEXT NOT NULL DEFAULT 'connected' CHECK (link IN ('connected', 'disconnected'));
ALTER TABLE sessions ADD COLUMN parent_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (parent_state IN ('live', 'gone', 'unknown'));
ALTER TABLE sessions ADD COLUMN agent_pid INTEGER;
ALTER TABLE sessions ADD COLUMN agent_start TEXT;
ALTER TABLE sessions ADD COLUMN parent_checked_at TEXT;

CREATE TABLE deliveries_v3 (
  message_id TEXT NOT NULL REFERENCES messages (id),
  recipient TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'pushed', 'failed', 'stuck', 'read')),
  hold_reason TEXT CHECK (hold_reason IN ('offline', 'unbound', 'low', 'muted', 'throttled', 'disconnected')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  transport TEXT,
  next_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (message_id, recipient)
);
INSERT INTO deliveries_v3 (message_id, recipient, state, hold_reason, attempts, last_error, transport, next_attempt_at,
  updated_at)
  SELECT message_id, recipient, state, hold_reason, attempts, last_error, transport, next_attempt_at, updated_at
  FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_v3 RENAME TO deliveries;
CREATE INDEX deliveries_recipient_state ON deliveries (recipient, state);
CREATE INDEX deliveries_state ON deliveries (state);
UPDATE sessions SET name_source = 'custom'
  WHERE name IS NOT NULL AND NOT (
    (name GLOB 'claude-?*-????' OR name GLOB 'codex-?*-????')
    AND substr(name, -5, 1) = '-'
    AND substr(name, -4) GLOB '[a-z2-7][a-z2-7][a-z2-7][a-z2-7]'
  );
CREATE INDEX sessions_agent_native ON sessions (agent, agent_session_id);

CREATE TABLE session_lineage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL CHECK (agent IN ('claude', 'codex')),
  native_id TEXT NOT NULL,
  previous_native_id TEXT,
  workspace TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES sessions (id),
  canonical_session_id TEXT REFERENCES sessions (id),
  cause TEXT NOT NULL CHECK (cause IN ('resume', 'fork', 'switch', 'continuation')),
  outcome TEXT NOT NULL CHECK (outcome IN ('adopted', 'flagged', 'observed')),
  reason TEXT,
  evidence_json TEXT NOT NULL,
  generation INTEGER,
  handoff_state TEXT CHECK (handoff_state IN ('pending', 'consumed', 'expired')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX session_lineage_native ON session_lineage (agent, native_id);

CREATE TABLE session_renames (
  session_id TEXT NOT NULL REFERENCES sessions (id),
  from_name TEXT,
  to_name TEXT NOT NULL,
  cause TEXT NOT NULL CHECK (cause IN ('register', 'native', 'launch', 'recovery')),
  name_source TEXT NOT NULL CHECK (name_source IN ('provisional', 'native', 'custom')),
  mail_moved INTEGER NOT NULL,
  subscriptions_moved INTEGER NOT NULL,
  mutes_moved INTEGER NOT NULL,
  at TEXT NOT NULL
);
${appendOnly('session_renames')}
`;

/** Metadata-derived Codex push evidence is refreshed at bind/probe and immediately before queueing. */
export const SCHEMA_V4 = `
ALTER TABLE question_relays ADD COLUMN submission_state TEXT NOT NULL DEFAULT 'unsent'
  CHECK (submission_state IN ('unsent', 'unknown', 'confirmed'));
UPDATE question_relays SET submission_state='confirmed' WHERE state='applied' AND kind IN ('codex', 'codex_async');
-- Pre-guard answers may already have reached Codex; never automatically repeat them after upgrade.
UPDATE question_relays SET submission_state='unknown',
  error=COALESCE(error, 'Native submission outcome unknown after upgrade; inspect native thread and resolve with wigwag questions resolve.')
  WHERE state='answered' AND kind IN ('codex', 'codex_async');
ALTER TABLE sessions ADD COLUMN codex_push_reason TEXT DEFAULT 'unverified-bind'
  CHECK (codex_push_reason IN ('shared-root', 'root-not-loaded', 'descendant-loaded', 'app-server-unavailable',
    'unverified-bind', 'too-many-loaded', 'unreadable-loaded'));
ALTER TABLE sessions ADD COLUMN bind_origin TEXT NOT NULL DEFAULT 'unverified'
  CHECK (bind_origin IN ('unverified', 'hook-verified'));
ALTER TABLE sessions ADD COLUMN host_client_name TEXT;
ALTER TABLE sessions ADD COLUMN host_client_version TEXT;
CREATE TABLE deliveries_v4 (
  message_id TEXT NOT NULL REFERENCES messages (id),
  recipient TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'pushed', 'failed', 'stuck', 'read')),
  hold_reason TEXT CHECK (hold_reason IN ('offline', 'unbound', 'low', 'muted', 'throttled', 'disconnected', 'codex-untrusted')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  transport TEXT,
  next_attempt_at TEXT,
  updated_at TEXT NOT NULL,
  forward_to TEXT REFERENCES sessions (id),
  PRIMARY KEY (message_id, recipient)
);
INSERT INTO deliveries_v4 (message_id, recipient, state, hold_reason, attempts, last_error, transport, next_attempt_at,
  updated_at)
  SELECT message_id, recipient, state, hold_reason, attempts, last_error, transport, next_attempt_at, updated_at
  FROM deliveries;
DROP TABLE deliveries;
ALTER TABLE deliveries_v4 RENAME TO deliveries;
CREATE INDEX deliveries_recipient_state ON deliveries (recipient, state);
CREATE INDEX deliveries_state ON deliveries (state);
CREATE INDEX deliveries_forward_to ON deliveries (forward_to) WHERE forward_to IS NOT NULL;
`;
