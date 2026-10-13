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
