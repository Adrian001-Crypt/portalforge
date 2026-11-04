export const MIGRATIONS: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'init',
    sql: `
CREATE TABLE users (id TEXT PRIMARY KEY, handle TEXT NOT NULL UNIQUE, display_name TEXT, created_at TEXT NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), csrf_token TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
  environment TEXT NOT NULL CHECK (environment IN ('development','testnet','demo')),
  visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','public_readonly')),
  network_id TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE members (project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL CHECK (role IN ('owner','developer','operator','viewer')), added_at TEXT NOT NULL, PRIMARY KEY (project_id, user_id));
CREATE TABLE api_keys (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, scopes TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT);
CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT, detail TEXT, at TEXT NOT NULL);
CREATE INDEX audit_project ON audit_log(project_id, id);

CREATE TABLE networks (id TEXT PRIMARY KEY, profile TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, alias TEXT NOT NULL,
  network_id TEXT NOT NULL, runtime TEXT NOT NULL CHECK (runtime IN ('evm','wasm')), address TEXT NOT NULL,
  deploy_block INTEGER NOT NULL, deploy_tx TEXT, source_commit TEXT, compiler TEXT, labels TEXT NOT NULL DEFAULT '[]',
  responsible TEXT, notes TEXT NOT NULL DEFAULT '', active_abi_version INTEGER NOT NULL DEFAULT 1,
  verification TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE (project_id, alias), UNIQUE (project_id, network_id, address)
);
CREATE TABLE contract_abis (contract_id TEXT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, version INTEGER NOT NULL, abi TEXT NOT NULL, abi_hash TEXT NOT NULL, note TEXT, created_at TEXT NOT NULL, PRIMARY KEY (contract_id, version));
CREATE TABLE contract_policies (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contract_alias TEXT NOT NULL, function_name TEXT NOT NULL,
  max_calls_per_hour INTEGER NOT NULL DEFAULT 20, max_fee_wei TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  UNIQUE (project_id, contract_alias, function_name)
);

CREATE TABLE deployments (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, network_id TEXT NOT NULL, manifest TEXT NOT NULL, manifest_hash TEXT NOT NULL, verification TEXT, verified_at TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (project_id, manifest_hash));

-- Indexer ---------------------------------------------------------------
CREATE TABLE cursors (
  stream_id TEXT PRIMARY KEY, network_id TEXT NOT NULL, interface TEXT NOT NULL CHECK (interface IN ('evm','native')),
  address TEXT, start_block INTEGER NOT NULL, next_block INTEGER NOT NULL, head_seen INTEGER, finalized_seen INTEGER,
  chunk_size INTEGER NOT NULL DEFAULT 2000, decoder_version TEXT, last_error TEXT, last_error_at TEXT, last_success_at TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE blocks (network_id TEXT NOT NULL, interface TEXT NOT NULL, number INTEGER NOT NULL, hash TEXT NOT NULL, parent_hash TEXT, timestamp INTEGER, spec_version INTEGER, finality TEXT NOT NULL, seen_at TEXT NOT NULL, PRIMARY KEY (network_id, interface, number));
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, network_id TEXT NOT NULL, interface TEXT NOT NULL,
  block_number INTEGER NOT NULL, block_hash TEXT NOT NULL, tx_hash TEXT, extrinsic_index INTEGER, log_index INTEGER NOT NULL,
  address TEXT, event_name TEXT, decoder_version TEXT, args TEXT, decode_error TEXT,
  finality TEXT NOT NULL CHECK (finality IN ('unconfirmed','safe','finalized','orphaned')),
  observed_at TEXT NOT NULL, raw TEXT NOT NULL, correlation_key TEXT
);
CREATE INDEX events_lookup ON events(network_id, address, event_name, block_number);
CREATE INDEX events_block ON events(network_id, interface, block_number);
CREATE INDEX events_corr ON events(correlation_key);

-- Workflows -------------------------------------------------------------
CREATE TABLE workflows (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, active_version INTEGER, enabled INTEGER NOT NULL DEFAULT 0, start_block INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (project_id, name));
CREATE TABLE workflow_versions (workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE, version INTEGER NOT NULL, definition TEXT NOT NULL, definition_hash TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workflow_id, version));
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions BEGIN SELECT RAISE(ABORT, 'workflow versions are immutable'); END;
CREATE TABLE connectors (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL, url TEXT NOT NULL, query_url TEXT, allow_private_host INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (project_id, name));

CREATE TABLE executions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workflow_id TEXT NOT NULL REFERENCES workflows(id), version INTEGER NOT NULL, network_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL, trigger_key TEXT NOT NULL, trigger TEXT NOT NULL, input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','running','awaiting_approval','broadcasting','pending','unknown','succeeded','failed','cancelled','dead_letter')),
  state_version INTEGER NOT NULL DEFAULT 0, lease_owner TEXT, lease_expires_at INTEGER, next_run_at INTEGER NOT NULL,
  cancel_requested INTEGER NOT NULL DEFAULT 0, error TEXT, result TEXT, result_hash TEXT, replay_of TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
  UNIQUE (workflow_id, trigger_key)
);
CREATE INDEX executions_claim ON executions(state, next_run_at);
CREATE INDEX executions_project ON executions(project_id, created_at);
CREATE TABLE steps (
  execution_id TEXT NOT NULL REFERENCES executions(id) ON DELETE CASCADE, step_id TEXT NOT NULL, type TEXT NOT NULL, position INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','succeeded','failed','unknown','skipped','awaiting_approval','waiting','retry_wait')),
  attempts INTEGER NOT NULL DEFAULT 0, output TEXT, error TEXT, reused_from TEXT, next_attempt_at INTEGER, started_at TEXT, finished_at TEXT,
  PRIMARY KEY (execution_id, step_id)
);
CREATE TABLE step_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, execution_id TEXT NOT NULL, step_id TEXT NOT NULL, attempt INTEGER NOT NULL, worker_id TEXT NOT NULL,
  state TEXT NOT NULL, input TEXT, output TEXT, error TEXT, started_at TEXT NOT NULL, finished_at TEXT, UNIQUE (execution_id, step_id, attempt)
);
CREATE TABLE intents (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, step_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('http','chain_tx')),
  idempotency_key TEXT NOT NULL UNIQUE, request TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','sent','confirmed','unknown','failed')),
  tx_hash TEXT, raw_tx TEXT, nonce INTEGER, from_address TEXT, response TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE approvals (
  id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, step_id TEXT NOT NULL, prompt TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','approved','rejected','expired','void')),
  execution_state_version INTEGER NOT NULL, requested_at TEXT NOT NULL, expires_at INTEGER NOT NULL, decided_by TEXT, decided_at TEXT, reason TEXT,
  UNIQUE (execution_id, step_id)
);
CREATE TABLE executor_spend (network_id TEXT NOT NULL, hour INTEGER NOT NULL, contract_alias TEXT NOT NULL, function_name TEXT NOT NULL, calls INTEGER NOT NULL DEFAULT 0, fee_wei TEXT NOT NULL DEFAULT '0', PRIMARY KEY (network_id, hour, contract_alias, function_name));
CREATE TABLE mutex (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);

-- Observability -----------------------------------------------------------
CREATE TABLE rpc_endpoints (id TEXT PRIMARY KEY, network_id TEXT NOT NULL, interface TEXT NOT NULL CHECK (interface IN ('evm','native')), url TEXT NOT NULL, label TEXT NOT NULL, builtin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (network_id, url));
CREATE TABLE rpc_samples (id INTEGER PRIMARY KEY AUTOINCREMENT, endpoint_id TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, latency_ms INTEGER, head INTEGER, finalized INTEGER, head_hash TEXT, spec_version INTEGER, error TEXT);
CREATE INDEX rpc_samples_ep ON rpc_samples(endpoint_id, at);
CREATE TABLE heartbeats (service TEXT NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL, info TEXT, PRIMARY KEY (service, instance));
CREATE TABLE incidents (
  id TEXT PRIMARY KEY, project_id TEXT, network_id TEXT, fingerprint TEXT NOT NULL, kind TEXT NOT NULL, severity TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  state TEXT NOT NULL CHECK (state IN ('open','acknowledged','resolved')), title TEXT NOT NULL,
  facts TEXT NOT NULL, inference TEXT, suggestion TEXT, refs TEXT NOT NULL DEFAULT '[]', count INTEGER NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, acknowledged_by TEXT, acknowledged_at TEXT, resolved_by TEXT, resolved_at TEXT, cooldown_until INTEGER
);
CREATE INDEX incidents_fp ON incidents(fingerprint, state);
CREATE TABLE incident_events (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE, at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, detail TEXT);
CREATE TABLE notification_channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, connector TEXT NOT NULL, min_severity TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, incident_id TEXT NOT NULL, channel_id TEXT NOT NULL, status TEXT NOT NULL, response_code INTEGER, error TEXT, at TEXT NOT NULL);

-- Evidence ----------------------------------------------------------------
CREATE TABLE evidence (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, evidence_id TEXT NOT NULL, kind TEXT NOT NULL, kind_hash TEXT NOT NULL, subject TEXT NOT NULL,
  content TEXT NOT NULL, content_hash TEXT NOT NULL, network_id TEXT NOT NULL, registry TEXT, execution_id TEXT,
  tx_hash TEXT, block_number INTEGER, status TEXT NOT NULL, verification TEXT, created_at TEXT NOT NULL, UNIQUE (project_id, evidence_id)
);
`,
  },
  {
    version: 2,
    name: 'routing',
    sql: `
CREATE TABLE trigger_seen (workflow_id TEXT NOT NULL, trigger_key TEXT NOT NULL, matched INTEGER NOT NULL, execution_id TEXT, at TEXT NOT NULL, PRIMARY KEY (workflow_id, trigger_key));
CREATE INDEX steps_state ON steps(execution_id, position);
CREATE INDEX intents_exec ON intents(execution_id, step_id);
`,
  },
  {
    version: 3,
    name: 'api',
    sql: `
CREATE TABLE probe_reports (id INTEGER PRIMARY KEY AUTOINCREMENT, network_id TEXT NOT NULL, report TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE wallet_intents (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('deploy','call')),
  network_id TEXT NOT NULL, chain_id INTEGER NOT NULL, from_address TEXT NOT NULL, to_address TEXT, contract_alias TEXT, function_name TEXT, args TEXT, data TEXT NOT NULL, data_hash TEXT NOT NULL,
  expected_nonce INTEGER, state TEXT NOT NULL CHECK (state IN ('awaiting_signature','submitted','confirmed','failed','rejected','unknown','replaced','expired')),
  tx_hash TEXT, receipt TEXT, error TEXT, note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX wallet_intents_open ON wallet_intents(project_id, from_address, state);
CREATE UNIQUE INDEX wallet_intents_hash ON wallet_intents(tx_hash) WHERE tx_hash IS NOT NULL;
`,
  },
  {
    version: 4,
    name: 'delivery_outbox',
    sql: `
ALTER TABLE incidents ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;
ALTER TABLE notifications ADD COLUMN delivery_key TEXT;
ALTER TABLE notifications ADD COLUMN payload TEXT;
ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE notifications ADD COLUMN lease_until INTEGER;
ALTER TABLE notifications ADD COLUMN claimed_by TEXT;
CREATE UNIQUE INDEX notifications_key ON notifications(delivery_key) WHERE delivery_key IS NOT NULL;
CREATE INDEX notifications_due ON notifications(status, next_attempt_at);
DELETE FROM notification_channels WHERE rowid NOT IN (SELECT MIN(rowid) FROM notification_channels GROUP BY project_id, connector);
CREATE UNIQUE INDEX notification_channels_connector ON notification_channels(project_id, connector);
ALTER TABLE wallet_intents ADD COLUMN deployment_id TEXT;
`,
  },
];
