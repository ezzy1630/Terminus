-- Terminus — Initial SQLite schema migration (Appendix C of SPEC.md).
--
-- This is the executable source of truth for the database schema. Prisma
-- (prisma/schema.prisma) is the TypeScript-facing client; this file is the
-- canonical DDL with STRICT tables, CHECK constraints, ON DELETE CASCADE,
-- partial unique indexes, and PRAGMAs that Prisma cannot express.
--
-- Per SPEC §29.2:
--   - WAL journal mode
--   - foreign keys ON
--   - busy_timeout 5000ms
--   - synchronous NORMAL
--   - monotonic checksum-verified migrations
--   - short, explicit write transactions
--   - JSON columns schema-versioned and validated before insertion

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;

-- ────────────────────────── Schema migrations ─────────────────────────────

CREATE TABLE IF NOT EXISTS schema_migrations (
    version             INTEGER PRIMARY KEY,
    name                TEXT NOT NULL,
    checksum_sha256     TEXT NOT NULL,
    applied_at          TEXT NOT NULL
) STRICT;

-- ────────────────────────── Core aggregates ───────────────────────────────

CREATE TABLE IF NOT EXISTS workspaces (
    id                  TEXT PRIMARY KEY,
    kind                TEXT NOT NULL CHECK (kind IN (
                            'local_git','local_directory','container','microvm','remote'
                        )),
    root_uri            TEXT NOT NULL,
    canonical_root      TEXT NOT NULL,
    trust               TEXT NOT NULL CHECK (trust IN ('trusted','untrusted','restricted')),
    repository_json     TEXT,
    policy_profile_id   TEXT NOT NULL,
    created_at          TEXT NOT NULL,
    last_opened_at      TEXT NOT NULL,
    deleted_at          TEXT
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_canonical_root_active
ON workspaces(canonical_root)
WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS sessions (
    id                      TEXT PRIMARY KEY,
    workspace_id            TEXT NOT NULL REFERENCES workspaces(id),
    owner_principal         TEXT NOT NULL,
    title                   TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('active','paused','archived','deleted')),
    default_model_profile   TEXT NOT NULL,
    default_permission_profile TEXT NOT NULL,
    active_thread_id        TEXT,
    metadata_json           TEXT NOT NULL DEFAULT '{}',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    archived_at             TEXT,
    deleted_at              TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS sessions_workspace_updated
ON sessions(workspace_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS threads (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_thread_id        TEXT REFERENCES threads(id),
    forked_from_turn_id     TEXT,
    status                  TEXT NOT NULL CHECK (status IN ('active','idle','paused','archived','deleted')),
    active_context_epoch_id TEXT,
    head_turn_id            TEXT,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS threads_session_created
ON threads(session_id, created_at);

CREATE TABLE IF NOT EXISTS tasks (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id               TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    status                  TEXT NOT NULL,
    phase                   TEXT NOT NULL,
    active_contract_version INTEGER NOT NULL DEFAULT 1,
    risk_class              TEXT NOT NULL DEFAULT 'normal',
    verification_plan_id    TEXT,
    budget_json             TEXT NOT NULL,
    scope_digest            TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    completed_at            TEXT,
    terminal_reason_json    TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS tasks_session_status
ON tasks(session_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_contract_versions (
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    version                 INTEGER NOT NULL,
    objective               TEXT NOT NULL,
    user_outcome            TEXT,
    non_goals_json          TEXT NOT NULL,
    constraints_json        TEXT NOT NULL,
    assumptions_json        TEXT NOT NULL,
    unknowns_json           TEXT NOT NULL,
    allowed_scope_json      TEXT NOT NULL,
    change_policy_json      TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    created_by              TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    PRIMARY KEY (task_id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS acceptance_criteria (
    task_id                 TEXT NOT NULL,
    contract_version        INTEGER NOT NULL,
    criterion_id            TEXT NOT NULL,
    statement               TEXT NOT NULL,
    verification_hint       TEXT,
    required                INTEGER NOT NULL CHECK (required IN (0,1)),
    status                  TEXT NOT NULL DEFAULT 'pending',
    PRIMARY KEY (task_id, contract_version, criterion_id),
    FOREIGN KEY (task_id, contract_version)
      REFERENCES task_contract_versions(task_id, version)
      ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS scope_ledger_entries (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    contract_version        INTEGER NOT NULL,
    resource_uri            TEXT NOT NULL,
    access_class            TEXT NOT NULL CHECK (access_class IN (
                                'read_allowed','write_allowed','read_observed',
                                'write_proposed','write_effective','external_proposed',
                                'external_effective','denied'
                            )),
    source                  TEXT NOT NULL,
    reason                  TEXT NOT NULL,
    approval_id             TEXT,
    created_at              TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS scope_ledger_task_resource
ON scope_ledger_entries(task_id, resource_uri, created_at);

CREATE TABLE IF NOT EXISTS turns (
    id                      TEXT PRIMARY KEY,
    thread_id               TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    task_id                 TEXT REFERENCES tasks(id),
    sequence                INTEGER NOT NULL,
    state                   TEXT NOT NULL,
    initiating_actor        TEXT NOT NULL,
    initiating_input_artifact TEXT,
    started_at              TEXT,
    completed_at            TEXT,
    terminal_error_json     TEXT,
    UNIQUE(thread_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS episodes (
    id                      TEXT PRIMARY KEY,
    turn_id                 TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    sequence                INTEGER NOT NULL,
    kind                    TEXT NOT NULL,
    model_visible           INTEGER NOT NULL CHECK (model_visible IN (0,1)),
    content_artifact        TEXT,
    tool_call_id            TEXT,
    source_versions_json    TEXT NOT NULL DEFAULT '{}',
    created_at              TEXT NOT NULL,
    UNIQUE(turn_id, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS provider_attempts (
    id                      TEXT PRIMARY KEY,
    turn_id                 TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    attempt_number          INTEGER NOT NULL,
    provider_id             TEXT NOT NULL,
    model_key               TEXT NOT NULL,
    capability_snapshot_hash TEXT NOT NULL,
    context_manifest_id     TEXT NOT NULL,
    request_artifact        TEXT NOT NULL,
    response_artifact       TEXT,
    native_continuation_json TEXT,
    status                  TEXT NOT NULL,
    usage_json              TEXT,
    cost_micros             INTEGER,
    started_at              TEXT NOT NULL,
    completed_at             TEXT,
    error_json              TEXT,
    UNIQUE(turn_id, attempt_number)
) STRICT;

CREATE TABLE IF NOT EXISTS context_epochs (
    id                      TEXT PRIMARY KEY,
    thread_id               TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    generation               INTEGER NOT NULL,
    provider_compatibility_key TEXT NOT NULL,
    baseline_artifact       TEXT NOT NULL,
    baseline_hash           TEXT NOT NULL,
    snapshot_artifact       TEXT NOT NULL,
    state                   TEXT NOT NULL CHECK (state IN ('initializing','active','replacement_pending','sealed')),
    created_at              TEXT NOT NULL,
    sealed_at               TEXT,
    seal_reason             TEXT,
    UNIQUE(thread_id, generation)
) STRICT;

CREATE TABLE IF NOT EXISTS context_manifests (
    id                      TEXT PRIMARY KEY,
    provider_attempt_id     TEXT UNIQUE,
    compiler_version        TEXT NOT NULL,
    policy_version          TEXT NOT NULL,
    epoch_id                TEXT REFERENCES context_epochs(id),
    provider_key            TEXT NOT NULL,
    model_key               TEXT NOT NULL,
    manifest_artifact       TEXT NOT NULL,
    rendered_request_hash   TEXT NOT NULL,
    estimated_tokens_json   TEXT NOT NULL,
    cache_plan_json         TEXT NOT NULL,
    experiment_json         TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    FOREIGN KEY (provider_attempt_id) REFERENCES provider_attempts(id)
) STRICT;

CREATE TABLE IF NOT EXISTS context_fragments (
    id                      TEXT PRIMARY KEY,
    manifest_id             TEXT NOT NULL REFERENCES context_manifests(id) ON DELETE CASCADE,
    fragment_key            TEXT NOT NULL,
    kind                    TEXT NOT NULL,
    source_uri              TEXT NOT NULL,
    source_version          TEXT,
    content_artifact        TEXT NOT NULL,
    authority               INTEGER NOT NULL,
    priority                INTEGER NOT NULL,
    trust                   TEXT NOT NULL,
    confidentiality         TEXT NOT NULL,
    injection_risk          TEXT NOT NULL,
    exactness               TEXT NOT NULL,
    selected                INTEGER NOT NULL CHECK (selected IN (0,1)),
    rendered_position       INTEGER,
    estimated_tokens        INTEGER NOT NULL,
    selection_reason        TEXT,
    omission_reason         TEXT,
    transformation_json     TEXT,
    invalidation_json       TEXT NOT NULL,
    UNIQUE(manifest_id, fragment_key)
) STRICT;

CREATE INDEX IF NOT EXISTS context_fragments_source
ON context_fragments(source_uri, source_version);

-- ────────────────────────── Artifacts (CAS) ───────────────────────────────

CREATE TABLE IF NOT EXISTS artifacts (
    hash                    TEXT PRIMARY KEY,
    size_bytes              INTEGER NOT NULL,
    media_type              TEXT NOT NULL,
    content_encoding        TEXT NOT NULL CHECK (content_encoding IN ('identity','zstd')),
    storage_path            TEXT NOT NULL,
    confidentiality         TEXT NOT NULL,
    trust                   TEXT NOT NULL,
    retention_class         TEXT NOT NULL CHECK (retention_class IN (
                                'ephemeral','session','audit','evidence','memory_source','legal_hold'
                            )),
    redaction_status        TEXT NOT NULL,
    source_uri              TEXT,
    source_version          TEXT,
    created_at              TEXT NOT NULL,
    last_verified_at        TEXT NOT NULL,
    quarantine_reason       TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS artifact_links (
    id                      TEXT PRIMARY KEY,
    artifact_hash           TEXT NOT NULL REFERENCES artifacts(hash),
    owner_type              TEXT NOT NULL,
    owner_id                TEXT NOT NULL,
    purpose                 TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    UNIQUE(artifact_hash, owner_type, owner_id, purpose)
) STRICT;

CREATE INDEX IF NOT EXISTS artifact_links_owner
ON artifact_links(owner_type, owner_id);

-- ────────────────────────── Tools, policy, approvals, effects ─────────────

CREATE TABLE IF NOT EXISTS tool_calls (
    id                      TEXT PRIMARY KEY,
    turn_id                 TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    provider_attempt_id     TEXT REFERENCES provider_attempts(id),
    tool_id                 TEXT NOT NULL,
    tool_version            TEXT NOT NULL,
    arguments_artifact      TEXT NOT NULL,
    normalized_operation_hash TEXT NOT NULL,
    state                   TEXT NOT NULL,
    policy_decision_id      TEXT,
    approval_id             TEXT,
    result_artifact         TEXT,
    result_status           TEXT,
    proposed_at             TEXT NOT NULL,
    started_at              TEXT,
    settled_at              TEXT,
    error_json              TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS tool_calls_turn_sequence
ON tool_calls(turn_id, proposed_at);

CREATE TABLE IF NOT EXISTS policy_decisions (
    id                      TEXT PRIMARY KEY,
    tool_call_id            TEXT REFERENCES tool_calls(id),
    effect_type             TEXT NOT NULL,
    normalized_input_artifact TEXT NOT NULL,
    decision                TEXT NOT NULL CHECK (decision IN ('allow','allow_with_constraints','prompt','deny')),
    rule_ids_json           TEXT NOT NULL,
    constraints_json        TEXT NOT NULL,
    policy_version          TEXT NOT NULL,
    explanation             TEXT NOT NULL,
    created_at              TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS approvals (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tool_call_id            TEXT REFERENCES tool_calls(id),
    operation_hash          TEXT NOT NULL,
    scope_json              TEXT NOT NULL,
    risk_json               TEXT NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired','revoked')),
    use_limit               INTEGER NOT NULL DEFAULT 1,
    use_count               INTEGER NOT NULL DEFAULT 0,
    expires_at              TEXT,
    requested_at            TEXT NOT NULL,
    resolved_at             TEXT,
    resolved_by             TEXT,
    rationale               TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS side_effects (
    id                      TEXT PRIMARY KEY,
    tool_call_id            TEXT NOT NULL REFERENCES tool_calls(id) ON DELETE CASCADE,
    effect_type             TEXT NOT NULL,
    resource_uri            TEXT NOT NULL,
    idempotency_key         TEXT NOT NULL,
    state                   TEXT NOT NULL,
    reversibility           TEXT NOT NULL,
    request_artifact        TEXT NOT NULL,
    evidence_artifact       TEXT,
    started_at              TEXT,
    settled_at              TEXT,
    reconciliation_json     TEXT,
    UNIQUE(effect_type, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS jobs (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id                 TEXT REFERENCES tasks(id),
    tool_call_id            TEXT REFERENCES tool_calls(id),
    state                   TEXT NOT NULL,
    command_artifact        TEXT NOT NULL,
    resolved_executable     TEXT,
    cwd_uri                 TEXT NOT NULL,
    environment_digest      TEXT NOT NULL,
    sandbox_id              TEXT NOT NULL,
    process_identity_json   TEXT,
    resource_limits_json    TEXT NOT NULL,
    output_artifact         TEXT NOT NULL,
    output_cursor           INTEGER NOT NULL DEFAULT 0,
    cleanup_policy_json     TEXT NOT NULL,
    started_at              TEXT,
    settled_at              TEXT,
    exit_json               TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS jobs_session
ON jobs(session_id);

-- ────────────────────────── Orchestration ─────────────────────────────────

CREATE TABLE IF NOT EXISTS agents (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    parent_agent_id         TEXT REFERENCES agents(id),
    role                    TEXT NOT NULL,
    adapter_id              TEXT,
    model_profile           TEXT NOT NULL,
    worktree_uri            TEXT,
    state                   TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    completed_at            TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS agents_task
ON agents(task_id);

CREATE TABLE IF NOT EXISTS delegations (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    agent_id                TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    contract_artifact       TEXT NOT NULL,
    contract_hash           TEXT NOT NULL,
    result_artifact         TEXT,
    status                  TEXT NOT NULL,
    budget_json             TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    completed_at            TEXT
) STRICT;

CREATE INDEX IF NOT EXISTS delegations_task
ON delegations(task_id);

-- ────────────────────────── Verification ──────────────────────────────────

CREATE TABLE IF NOT EXISTS verification_plans (
    id                      TEXT PRIMARY KEY,
    task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    contract_version        INTEGER NOT NULL,
    source_revision         TEXT NOT NULL,
    completion_expression   TEXT NOT NULL,
    plan_artifact           TEXT NOT NULL,
    created_at              TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS verification_nodes (
    id                      TEXT PRIMARY KEY,
    plan_id                 TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
    kind                    TEXT NOT NULL,
    required                INTEGER NOT NULL CHECK (required IN (0,1)),
    specification_json      TEXT NOT NULL,
    timeout_ms              INTEGER,
    retry_policy_json       TEXT NOT NULL,
    UNIQUE(plan_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS verification_edges (
    plan_id                 TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
    from_node_id            TEXT NOT NULL REFERENCES verification_nodes(id) ON DELETE CASCADE,
    to_node_id              TEXT NOT NULL REFERENCES verification_nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (plan_id, from_node_id, to_node_id)
) STRICT;

CREATE TABLE IF NOT EXISTS verification_results (
    id                      TEXT PRIMARY KEY,
    plan_id                 TEXT NOT NULL REFERENCES verification_plans(id) ON DELETE CASCADE,
    node_id                 TEXT NOT NULL REFERENCES verification_nodes(id) ON DELETE CASCADE,
    attempt                 INTEGER NOT NULL,
    status                  TEXT NOT NULL CHECK (status IN ('pass','fail','error','skipped','blocked')),
    source_revision         TEXT NOT NULL,
    environment_digest      TEXT NOT NULL,
    evidence_artifact       TEXT,
    tool_call_id            TEXT REFERENCES tool_calls(id),
    started_at              TEXT NOT NULL,
    completed_at            TEXT,
    reason                  TEXT,
    UNIQUE(plan_id, node_id, attempt)
) STRICT;

CREATE INDEX IF NOT EXISTS verification_results_plan
ON verification_results(plan_id);

-- ────────────────────────── Memory ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS memory_claims (
    id                      TEXT PRIMARY KEY,
    kind                    TEXT NOT NULL,
    statement               TEXT NOT NULL,
    statement_hash          TEXT NOT NULL,
    scope_json              TEXT NOT NULL,
    provenance_json         TEXT NOT NULL,
    confidence_ppm          INTEGER NOT NULL CHECK (confidence_ppm BETWEEN 0 AND 1000000),
    verification_json       TEXT NOT NULL,
    invalidation_json       TEXT NOT NULL,
    usage_json              TEXT NOT NULL,
    status                  TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL,
    UNIQUE(statement_hash, scope_json)
) STRICT;

CREATE TABLE IF NOT EXISTS memory_relations (
    from_memory_id          TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
    to_memory_id            TEXT NOT NULL REFERENCES memory_claims(id) ON DELETE CASCADE,
    relation                TEXT NOT NULL CHECK (relation IN ('supports','contradicts','supersedes')),
    status                  TEXT NOT NULL,
    created_at              TEXT NOT NULL,
    PRIMARY KEY(from_memory_id, to_memory_id, relation)
) STRICT;

-- ────────────────────────── Capabilities ──────────────────────────────────

CREATE TABLE IF NOT EXISTS capabilities (
    id                      TEXT NOT NULL,
    version                 TEXT NOT NULL,
    kind                    TEXT NOT NULL,
    source                  TEXT NOT NULL,
    content_hash            TEXT NOT NULL,
    descriptor_hash         TEXT NOT NULL,
    trust_level             TEXT NOT NULL,
    manifest_artifact       TEXT NOT NULL,
    status                  TEXT NOT NULL,
    admitted_at             TEXT,
    revoked_at              TEXT,
    PRIMARY KEY(id, version)
) STRICT;

CREATE TABLE IF NOT EXISTS capability_activations (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    task_id                 TEXT REFERENCES tasks(id),
    capability_id           TEXT NOT NULL,
    capability_version      TEXT NOT NULL,
    state                   TEXT NOT NULL,
    granted_scope_json      TEXT NOT NULL,
    activated_at            TEXT NOT NULL,
    deactivated_at          TEXT,
    FOREIGN KEY(capability_id, capability_version)
      REFERENCES capabilities(id, version)
) STRICT;

-- ────────────────────────── Infrastructure ────────────────────────────────

CREATE TABLE IF NOT EXISTS idempotency_records (
    principal               TEXT NOT NULL,
    method                  TEXT NOT NULL,
    idempotency_key         TEXT NOT NULL,
    request_hash            TEXT NOT NULL,
    state                   TEXT NOT NULL,
    response_artifact       TEXT,
    error_json              TEXT,
    created_at              TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    PRIMARY KEY(principal, method, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS leases (
    lease_key               TEXT PRIMARY KEY,
    owner_instance          TEXT NOT NULL,
    fencing_token           INTEGER NOT NULL,
    acquired_at             TEXT NOT NULL,
    expires_at              TEXT NOT NULL,
    metadata_json           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS semantic_events (
    event_id                TEXT PRIMARY KEY,
    event_type              TEXT NOT NULL,
    schema_version          INTEGER NOT NULL,
    aggregate_type          TEXT NOT NULL,
    aggregate_id            TEXT NOT NULL,
    aggregate_sequence      INTEGER NOT NULL,
    occurred_at             TEXT NOT NULL,
    actor_json              TEXT NOT NULL,
    correlation_id          TEXT NOT NULL,
    causation_id            TEXT,
    idempotency_key         TEXT,
    payload_json            TEXT NOT NULL,
    artifact_refs_json      TEXT NOT NULL,
    trace_id                TEXT,
    UNIQUE(aggregate_type, aggregate_id, aggregate_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS semantic_events_correlation
ON semantic_events(correlation_id, occurred_at);

CREATE INDEX IF NOT EXISTS semantic_events_aggregate
ON semantic_events(aggregate_type, aggregate_id, occurred_at);

CREATE TABLE IF NOT EXISTS event_stream_cursors (
    stream_name             TEXT PRIMARY KEY,
    last_event_id           TEXT NOT NULL,
    last_sequence           INTEGER NOT NULL,
    updated_at              TEXT NOT NULL
) STRICT;

-- ────────────────────────── FTS5 full-text search (§7.3) ───────────────────
-- Source files and memory claims are indexed for lexical retrieval.

CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
    workspace_id UNINDEXED,
    relative_path UNINDEXED,
    content,
    source_version UNINDEXED,
    tokenize = 'porter unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    statement,
    scope_json UNINDEXED,
    tokenize = 'porter unicode61'
);

-- ────────────────────────── Checkpoints (§29.5) ───────────────────────────

CREATE TABLE IF NOT EXISTS checkpoints (
    id                      TEXT PRIMARY KEY,
    session_id              TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    thread_id               TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    task_id                 TEXT REFERENCES tasks(id) ON DELETE CASCADE,
    checkpoint_artifact     TEXT NOT NULL,
    schema_version          INTEGER NOT NULL,
    last_committed_sequences_json TEXT NOT NULL,
    active_context_epoch_id TEXT,
    promoted_input_cursor   TEXT,
    unsettled_tool_calls_json TEXT NOT NULL DEFAULT '[]',
    active_jobs_json        TEXT NOT NULL DEFAULT '[]',
    workspace_revision      TEXT,
    dirty_state_digest      TEXT,
    unsettled_effects_json  TEXT NOT NULL DEFAULT '[]',
    artifact_refs_json      TEXT NOT NULL DEFAULT '[]',
    continuation_json       TEXT,
    created_at              TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS checkpoints_thread_created
ON checkpoints(thread_id, created_at DESC);

-- ────────────────────────── Recovery reports (§29.5) ──────────────────────

CREATE TABLE IF NOT EXISTS recovery_reports (
    id                      TEXT PRIMARY KEY,
    started_at              TEXT NOT NULL,
    completed_at             TEXT,
    instance_id             TEXT NOT NULL,
    schema_version          INTEGER NOT NULL,
    non_terminal_tasks      INTEGER NOT NULL DEFAULT 0,
    non_terminal_turns      INTEGER NOT NULL DEFAULT 0,
    reconciled_jobs         INTEGER NOT NULL DEFAULT 0,
    lost_jobs               INTEGER NOT NULL DEFAULT 0,
    reconciled_effects      INTEGER NOT NULL DEFAULT 0,
    manual_review_effects   INTEGER NOT NULL DEFAULT 0,
    integrity_ok            INTEGER NOT NULL CHECK (integrity_ok IN (0,1)),
    report_artifact         TEXT,
    details_json            TEXT NOT NULL DEFAULT '{}'
) STRICT;

-- The migration runner (`scripts/migrate.ts`) records this migration in
-- `schema_migrations` with a sha256 checksum computed from this file's bytes
-- (SPEC §29.2: monotonic, checksum-verified migrations). Do NOT record the
-- migration here: a second INSERT would conflict on the `version` primary key
-- and would embed a stale placeholder checksum. The runner is the single
-- source of truth for the applied-migration ledger.
