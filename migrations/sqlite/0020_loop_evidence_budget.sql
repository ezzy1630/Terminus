-- Durable projections for the provider-neutral coding loop.
-- These tables retain hashes, bounded metadata, and deterministic ledgers;
-- provider arguments and response bodies remain in content-addressed artifacts.

CREATE TABLE operation_observations (
    id                       TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
    turn_id                  TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    provider_attempt_id      TEXT NOT NULL REFERENCES provider_attempts(id) ON DELETE CASCADE,
    schema_version           TEXT NOT NULL CHECK (length(trim(schema_version)) BETWEEN 1 AND 128),
    observation_hash         TEXT NOT NULL CHECK (observation_hash GLOB 'sha256:*'),
    semantic_fingerprint     TEXT NOT NULL CHECK (semantic_fingerprint GLOB 'sha256:*'),
    attempt_number           INTEGER NOT NULL CHECK (attempt_number > 0),
    provider_call_id         TEXT NOT NULL CHECK (length(trim(provider_call_id)) BETWEEN 1 AND 255),
    tool_id                  TEXT NOT NULL CHECK (length(trim(tool_id)) BETWEEN 1 AND 255),
    tool_version             TEXT,
    status                   TEXT NOT NULL CHECK (status IN ('success', 'partial', 'error', 'denied', 'timeout', 'cancelled', 'unknown')),
    result_hash              TEXT CHECK (result_hash IS NULL OR result_hash GLOB 'sha256:*'),
    error_code               TEXT,
    error_class              TEXT,
    mutates_workspace        INTEGER NOT NULL CHECK (mutates_workspace IN (0, 1)),
    workspace_revision_before TEXT,
    workspace_revision_after TEXT,
    verification_delta       TEXT CHECK (verification_delta IS NULL OR verification_delta GLOB 'sha256:*'),
    hypothesis_id            TEXT,
    criterion_ids_json       TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(criterion_ids_json) = 1),
    objective_step           TEXT,
    progressed               INTEGER NOT NULL CHECK (progressed IN (0, 1)),
    no_op                    INTEGER NOT NULL CHECK (no_op IN (0, 1)),
    repeated_failure         INTEGER NOT NULL CHECK (repeated_failure IN (0, 1)),
    oscillating              INTEGER NOT NULL CHECK (oscillating IN (0, 1)),
    failure_class            TEXT,
    progress_reason          TEXT NOT NULL CHECK (progress_reason IN ('new_operation', 'workspace_changed', 'verification_changed', 'result_changed', 'no_op', 'repeated_failure', 'oscillation')),
    recommended_recovery_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recommended_recovery_json) = 1),
    created_at               BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    UNIQUE(turn_id, observation_hash)
);

CREATE INDEX operation_observations_turn_semantic
    ON operation_observations(turn_id, semantic_fingerprint);

CREATE INDEX operation_observations_provider_attempt
    ON operation_observations(provider_attempt_id);

CREATE TABLE turn_budget_ledgers (
    id                                  TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
    turn_id                             TEXT NOT NULL UNIQUE REFERENCES turns(id) ON DELETE CASCADE,
    schema_version                      TEXT NOT NULL CHECK (length(trim(schema_version)) BETWEEN 1 AND 128),
    steps_used                          INTEGER NOT NULL CHECK (steps_used >= 0),
    max_steps                           INTEGER NOT NULL CHECK (max_steps >= 0),
    hard_max_steps                      INTEGER NOT NULL CHECK (hard_max_steps >= max_steps),
    tokens_used                         BIGINT NOT NULL CHECK (tokens_used >= 0),
    input_tokens                        BIGINT NOT NULL CHECK (input_tokens >= 0),
    cached_input_tokens                 BIGINT NOT NULL CHECK (cached_input_tokens >= 0),
    cache_write_tokens                  BIGINT NOT NULL CHECK (cache_write_tokens >= 0),
    output_tokens                       BIGINT NOT NULL CHECK (output_tokens >= 0),
    reasoning_tokens                    BIGINT NOT NULL CHECK (reasoning_tokens >= 0),
    tool_schema_tokens                  BIGINT NOT NULL CHECK (tool_schema_tokens >= 0),
    max_tokens                          BIGINT CHECK (max_tokens IS NULL OR max_tokens >= 0),
    cost_micros                         BIGINT NOT NULL CHECK (cost_micros >= 0),
    max_cost_micros                     BIGINT CHECK (max_cost_micros IS NULL OR max_cost_micros >= 0),
    context_headroom_tokens             BIGINT CHECK (context_headroom_tokens IS NULL OR context_headroom_tokens >= 0),
    final_verification_reserve_tokens  BIGINT NOT NULL CHECK (final_verification_reserve_tokens >= 0),
    final_verification_reserve_cost_micros BIGINT NOT NULL CHECK (final_verification_reserve_cost_micros >= 0),
    context_budget_json                 TEXT CHECK (context_budget_json IS NULL OR json_valid(context_budget_json) = 1),
    evidence_json                       TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(evidence_json) = 1),
    last_progress_json                  TEXT CHECK (last_progress_json IS NULL OR json_valid(last_progress_json) = 1),
    created_at                          BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    updated_at                          BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
);

CREATE TABLE evidence_bundles (
    id                            TEXT PRIMARY KEY NOT NULL CHECK (length(trim(id)) BETWEEN 1 AND 255),
    task_id                       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    turn_id                       TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
    schema_version                TEXT NOT NULL CHECK (length(trim(schema_version)) BETWEEN 1 AND 128),
    identity_hash                 TEXT NOT NULL CHECK (identity_hash GLOB 'sha256:*'),
    contract_version              INTEGER NOT NULL CHECK (contract_version > 0),
    base_workspace_revision       TEXT NOT NULL CHECK (length(trim(base_workspace_revision)) BETWEEN 1 AND 255),
    final_workspace_revision      TEXT NOT NULL CHECK (length(trim(final_workspace_revision)) BETWEEN 1 AND 255),
    profile_id                    TEXT NOT NULL CHECK (length(trim(profile_id)) BETWEEN 1 AND 128),
    profile_version               TEXT NOT NULL CHECK (length(trim(profile_version)) BETWEEN 1 AND 64),
    profile_hash                  TEXT NOT NULL CHECK (profile_hash GLOB 'sha256:*'),
    bundle_artifact               TEXT NOT NULL CHECK (length(trim(bundle_artifact)) BETWEEN 1 AND 255),
    provider_attempt_ids_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(provider_attempt_ids_json) = 1),
    context_manifest_ids_json     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(context_manifest_ids_json) = 1),
    request_artifact_hashes_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(request_artifact_hashes_json) = 1),
    response_artifact_hashes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(response_artifact_hashes_json) = 1),
    tool_call_ids_json            TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tool_call_ids_json) = 1),
    verification_result_ids_json  TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(verification_result_ids_json) = 1),
    proof_bundle_hash              TEXT CHECK (proof_bundle_hash IS NULL OR proof_bundle_hash GLOB 'sha256:*'),
    terminal_outcome               TEXT NOT NULL CHECK (terminal_outcome IN ('COMPLETED', 'BLOCKED', 'NEEDS_USER_DECISION', 'BUDGET_EXHAUSTED', 'POLICY_DENIED', 'FAILED_VERIFICATION', 'ABORTED', 'FAILED')),
    admission_state                TEXT NOT NULL DEFAULT 'COMMITTED' CHECK (admission_state IN ('PREPARED', 'COMMITTED', 'QUARANTINED')),
    created_at                     BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    updated_at                     BIGINT NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
    UNIQUE(task_id, turn_id)
);

CREATE INDEX evidence_bundles_task_outcome_created
    ON evidence_bundles(task_id, terminal_outcome, created_at);

CREATE INDEX evidence_bundles_identity
    ON evidence_bundles(identity_hash);
